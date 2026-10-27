import { randomUUID } from "node:crypto";
import type { CanonicalEvent, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { DEFAULT_GUARDRAILS, evaluateHandoff } from "@my-team-agents/domain";
import { ExecutionStore, type AttemptRecord, type TaskRecord, type TaskResult } from "./execution-store.js";
import { parseHandoffArgs } from "./handoff-intent.js";

export interface WorkerOptions {
  workerId?: string;
  adapterFor(memberId: string): RuntimeAdapter;
  leaseMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  onChange?: () => void;
}

export interface ResolvedHandoff {
  sourceToolCallId: string;
  toMemberId: string;
  reason: string;
  input: {
    tenantId: string;
    projectId: string;
    memberId: string;
    workspacePath: string;
    prompt: string;
    groupId?: string;
    model?: string;
  };
}

export interface DurableWorker {
  runOnce(): Promise<boolean>;
  recoverExpired(): number;
  requestCancel(taskId: string): { affected: number; attemptId: string | null };
}

const hasStructuredResult = (value: unknown): value is TaskResult => {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<TaskResult>;
  return ["success", "partial", "failed"].includes(result.outcome ?? "")
    && typeof result.summary === "string" && result.summary.trim().length > 0
    && Array.isArray(result.artifacts) && Array.isArray(result.remainingRisks)
    && result.artifacts.every((a) => typeof a === "object" && a !== null
      && typeof (a as { path?: unknown }).path === "string")
    && result.remainingRisks.every((r) => typeof r === "string");
};

const unknownHighRiskTools = (events: CanonicalEvent[]): string[] => {
  const safeTools = new Set(["read", "grep", "glob", "find", "ls", "handoff_to", "submit_result"]);
  const pending = new Map<string, string>();
  for (const event of events) {
    if (!event.toolCallId || !event.toolName || safeTools.has(event.toolName)) continue;
    if (event.type === "tool_execution_start") pending.set(event.toolCallId, event.toolName);
    if (event.type === "tool_execution_end") pending.delete(event.toolCallId);
  }
  return [...new Set(pending.values())];
};

const latestText = (events: CanonicalEvent[]): string =>
  [...events].reverse().find((e) => e.type === "message_end" && e.text)?.text ?? "";

const parseResult = (text: string): TaskResult | null => {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) candidates.push(match[1]?.trim() ?? "");
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (hasStructuredResult(value)) return value;
    } catch { /* Final prose is not a structured task result. */ }
  }
  return null;
};

/** Conservative P6 recovery: durable events, bounded attempts and fenced writes. */
export function createDurableWorker(store: ExecutionStore, options: WorkerOptions): DurableWorker {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const now = options.now ?? Date.now;
  const onChange = options.onChange ?? (() => {});
  const active = new Map<string, { attempt: AttemptRecord; chainId: string }>();

  async function execute(task: TaskRecord, attempt: AttemptRecord): Promise<void> {
    active.set(attempt.id, { attempt, chainId: task.chainId });
    const heartbeat = setInterval(() => {
      if (!store.heartbeat(attempt.id, attempt.fencingToken)) clearInterval(heartbeat);
    }, Math.max(10, Math.min(10_000, leaseMs / 3)));
    heartbeat.unref();
    const events: CanonicalEvent[] = [];
    let lastEventAt = now();
    let failure: string | null = null;
    let cancelled = false;

    try {
      store.markAttemptRunning(attempt.id, attempt.fencingToken);
      const adapter = options.adapterFor(task.memberId);
      const snapshot = task.recoverySnapshot ? `\n\nRecovery snapshot:\n${task.recoverySnapshot}` : "";
      const originalPrompt = (() => {
        if (!task.recoverySnapshot) return task.prompt;
        try {
          const saved = JSON.parse(task.recoverySnapshot) as { originalTask?: unknown };
          return typeof saved.originalTask === "string" ? saved.originalTask : task.prompt;
        } catch { return task.prompt; }
      })();
      const prompt = `${originalPrompt}${snapshot}\n\nAt the end, provide a final JSON result with outcome ("success"|"partial"|"failed"), summary, artifacts (each with path), and remainingRisks.`;
      const handle = await adapter.start({
        runId: attempt.id, tenantId: task.tenantId, projectId: task.projectId,
        memberId: task.memberId, workspacePath: task.workspacePath, prompt,
        ...(task.model ? { model: task.model } : {}),
      });
      const watchdog = setInterval(() => {
        if (now() - lastEventAt >= idleTimeoutMs) {
          failure = `no events for ${idleTimeoutMs}ms`;
          void handle.cancel("abort");
        }
        if (!store.heartbeat(attempt.id, attempt.fencingToken, now(), leaseMs)) {
          failure = "lease lost; stop the superseded attempt";
          void handle.cancel("abort");
          return;
        }
        if (store.getChain(task.chainId).cancelRequested) {
          cancelled = true;
          void handle.cancel("abort");
        }
      }, Math.min(1000, idleTimeoutMs));
      watchdog.unref();
      try {
        for await (const event of handle.events) {
          lastEventAt = now();
          events.push(event);
          store.appendEvent(attempt.id, attempt.fencingToken, event);
          onChange();
        }
        const result = await handle.settled;
        if (result.status !== "completed") failure = failure ?? result.error ?? `runtime ${result.status}`;
      } finally {
        clearInterval(watchdog);
      }

      if (cancelled || store.getChain(task.chainId).cancelRequested) {
        store.finishFailure(attempt.id, attempt.fencingToken, "cancel requested", { now: now() });
        return;
      }
      if (failure) {
        store.finishFailure(attempt.id, attempt.fencingToken, failure, { now: now() });
        return;
      }
      const unresolved = unknownHighRiskTools(events);
      if (unresolved.length > 0) {
        store.finishFailure(attempt.id, attempt.fencingToken,
          `unknown tool outcomes require human review: ${unresolved.join(", ")}`,
          { blocked: true, now: now() });
        return;
      }
      const structured = parseResult(latestText(events));
      if (!structured) {
        store.finishFailure(attempt.id, attempt.fencingToken,
          "missing valid structured result (outcome, summary, artifacts, remainingRisks)", { now: now() });
        return;
      }
      if (structured.outcome === "failed") {
        store.finishFailure(attempt.id, attempt.fencingToken, structured.summary, { now: now() });
        return;
      }

      const handoffs: ResolvedHandoff[] = [];
      const issues: string[] = [];
      for (const event of events) {
        if (event.type !== "tool_execution_start" || event.toolName !== "handoff_to") continue;
        const parsed = parseHandoffArgs(event.args);
        issues.push(...parsed.issues);
        if (!event.toolCallId) {
          issues.push("handoff has no toolCallId and cannot be dispatched durably");
          continue;
        }
        for (const intent of parsed.intents) {
          const targets = intent.toMemberIds;
          const chain = store.getChain(task.chainId);
          const decision = evaluateHandoff(
            { depth: task.depth, budgetUsed: chain.budgetUsed, visitCounts: chain.visitCounts },
            targets,
          );
          if (!decision.allowed) {
            issues.push(`handoff rejected: ${decision.reason ?? "guardrail"}`);
            continue;
          }
          const remainingBudget = DEFAULT_GUARDRAILS.budgetMax - chain.budgetUsed;
          const affordable = targets.slice(0, Math.max(0, remainingBudget));
          const overBudget = targets.slice(affordable.length);
          if (overBudget.length > 0) {
            issues.push(`handoff rejected: ${overBudget.join(", ")} exceeds remaining chain budget`);
          }
          for (const memberId of affordable) {
            const args = typeof event.args === "object" && event.args !== null
              ? event.args as Record<string, unknown> : {};
            const work = typeof args.workPackage === "string" ? args.workPackage : intent.reason;
            handoffs.push({
              sourceToolCallId: event.toolCallId,
              toMemberId: memberId,
              reason: intent.reason,
              input: {
                tenantId: task.tenantId, projectId: task.projectId, memberId,
                workspacePath: task.workspacePath, prompt: work,
                ...(task.groupId ? { groupId: task.groupId } : {}),
              },
            });
          }
        }
      }
      if (issues.length > 0 && handoffs.length === 0) {
        store.finishFailure(attempt.id, attempt.fencingToken, issues.join("; "), { now: now() });
        return;
      }
      store.completeSuccess(attempt.id, attempt.fencingToken, structured, handoffs, now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { store.finishFailure(attempt.id, attempt.fencingToken, message, { now: now() }); }
      catch { /* A superseded Attempt cannot overwrite the new owner's state. */ }
    } finally {
      clearInterval(heartbeat);
      active.delete(attempt.id);
      onChange();
    }
  }

  return {
    async runOnce() {
      const claimed = store.claimNext(workerId, now(), leaseMs);
      if (!claimed) return false;
      await execute(claimed.task, claimed.attempt);
      return true;
    },
    recoverExpired() {
      let recovered = 0;
      for (const attempt of store.expiredAttempts(now())) {
        const task = store.getTask(attempt.taskId);
        const events = task ? store.getEvents(task.id).filter((e) => e.attemptId === attempt.id).map((e) => e.event) : [];
        const unsafe = unknownHighRiskTools(events);
        store.recoverAttempt(attempt.id, `lease expired: ${attempt.id}`, unsafe.length > 0, now());
        recovered += 1;
      }
      if (recovered > 0) onChange();
      return recovered;
    },
    requestCancel(taskId) {
      const task = store.getTask(taskId);
      if (!task) return { affected: 0, attemptId: null };
      const affected = store.requestCancelChain(task.chainId, now());
      const attempt = task.activeAttemptId ? active.get(task.activeAttemptId) : undefined;
      onChange();
      return { affected, attemptId: attempt?.attempt.id ?? task.activeAttemptId };
    },
  };
}
