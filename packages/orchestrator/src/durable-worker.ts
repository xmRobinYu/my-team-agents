import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { CanonicalEvent, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { DEFAULT_GUARDRAILS, TERMINATION_MARKER, evaluateHandoff } from "@my-team-agents/domain";
import type { ChatRoom } from "@my-team-agents/domain";
import { ExecutionStore, type AttemptRecord, type TaskRecord, type TaskResult } from "./execution-store.js";
import { parseHandoffArgs } from "./handoff-intent.js";
import { evaluateTermination, evaluateTrigger, formatBlockReason } from "./room-guards.js";
import { queueWrapUpTask } from "./room-trigger.js";
import type { RoomStore } from "./room-store.js";

export interface WorkerOptions {
  workerId?: string;
  adapterFor(memberId: string): RuntimeAdapter;
  /**
   * I4: rooms the worker writes agent replies into. Only group-chat Tasks
   * (`groupId` set) touch it, so a worker without it still runs every other Task
   * exactly as before.
   */
  rooms?: RoomStore;
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

/**
 * I6: the guard verdicts for one batch of handoffs, computed BEFORE the commit
 * transaction and written INSIDE it (see `planRoomGuards`).
 */
interface GuardPlan {
  roomId: string;
  room: ChatRoom;
  /** Handoffs the guards allowed; these become child Tasks. */
  kept: ResolvedHandoff[];
  /** Handoffs the guards refused; each gets a system message, no Task. */
  blocked: Array<{ memberId: string; reason: string }>;
  /** Some allowed handoff lands exactly on `maxRounds` (AC5.1). */
  reachesCap: boolean;
  /** Projected round count after all allowed handoffs of this batch. */
  rounds: number;
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
  const rooms = options.rooms;
  // Same rule as `postRoomMessage`: the reply and the Task row must share one
  // database handle, otherwise "task succeeded" and "reply landed" cannot commit
  // together. Checked once up front instead of failing mid-run.
  if (rooms && rooms.db !== store.db) {
    throw new Error("createDurableWorker needs RoomStore and ExecutionStore over one database handle");
  }

  /**
   * I4: post the agent's reply into the shared room stream, so the next trigger
   * injects what this agent actually said. Without this the "history" would only
   * ever contain user messages and group chat would be an illusion.
   *
   * Content is `structured.summary`: the worker only reaches here with a validated
   * structured result, so `summary` is the one field guaranteed to be non-empty
   * human-readable prose. The raw `latestText` may be a JSON envelope, which is
   * unreadable as a chat message.
   *
   * Idempotent by `taskId`: a replay or a retried Attempt re-injects the same
   * history and must not make the agent speak twice.
   *
   * The return value is what I6 needs: `true` means THIS call wrote the reply, so
   * the flow-state writes that follow (rounds, termination) run exactly once per
   * Task. Without it, a replay of a successful Task would count its rounds twice.
   */
  function appendAgentReply(task: TaskRecord, result: TaskResult): boolean {
    if (!rooms || !task.groupId) return false;
    if (rooms.getMessageByTask(task.id)) return false;
    rooms.appendMessage({
      roomId: task.groupId,
      authorKind: "agent",
      // `memberId` IS the RoomAgent id for group Tasks (see postRoomMessage).
      authorAgentId: task.memberId,
      content: result.summary,
      taskId: task.id,
    }, now());
    return true;
  }

  /**
   * I6 entry point C — the termination signal, read off the reply that was just
   * written. Only the coordinator can end a room (AC6.1); anyone else typing
   * `[讨论结束]` has the attempt ignored, with a warn AND a system message so the
   * stream itself shows why nothing stopped (AC6.2).
   *
   * The marker is data in a chat log; the flag is written by code. That is the
   * AGENTS.md rule in force: an agent can propose an ending, it cannot decide one.
   */
  function applyTermination(task: TaskRecord, result: TaskResult): void {
    if (!rooms || !task.groupId) return;
    const agent = rooms.getAgent(task.memberId);
    if (!agent) {
      // A group Task whose persona is gone cannot be judged as coordinator or not.
      // Leaving the room running is the safe direction, and the reply is still in
      // the stream, so nothing is silently dropped.
      console.warn(`[room-guards] ${task.groupId}: 无法判定终止 — 找不到 agent ${task.memberId}`);
      return;
    }
    const decision = evaluateTermination(result.summary, agent);
    if (decision.terminate) {
      rooms.markTerminated(task.groupId, now());
      rooms.appendMessage({
        roomId: task.groupId,
        authorKind: "system",
        content: `【流程守卫·终止】协调者 ${agent.name} 宣布讨论结束，本群后续 agent 触发将被阻断；用户发送新消息可重新开始。`,
      }, now());
      return;
    }
    if (decision.ignoredAttempt) {
      console.warn(
        `[room-guards] ${task.groupId}: 非协调者 ${agent.name} 输出了 ${TERMINATION_MARKER}，已忽略（终止权只在协调者）`,
      );
      rooms.appendMessage({
        roomId: task.groupId,
        authorKind: "system",
        content: `【流程守卫·终止】${agent.name} 不是本群协调者，其 ${TERMINATION_MARKER} 被忽略，讨论继续。`,
      }, now());
    }
  }

  /**
   * I6 entry point B — the loop and round guard for agent→agent dispatch.
   *
   * `handoff_to` already produces child Tasks (P6), so this IS the real
   * interception point for A→B→A; nothing here waits for I5's `@name` path.
   *
   * Read, judgement and write all happen INSIDE the commit transaction
   * (`BEGIN IMMEDIATE`), which is the only shape that is actually correct here:
   *  - a user message posted while this Task was running resets the chain and the
   *    round count. Judging against a snapshot read BEFORE the transaction would
   *    let that reset slip in underneath and charge rounds to a turn that already
   *    ended — so the state is read after the lock is held;
   *  - "this handoff is blocked" + "the system message saying so" + "that round is
   *    counted" + "the child Task exists" commit as one unit. Writing the system
   *    message outside the transaction would let a crash leave a refusal nobody can
   *    see, or a round counted for a child that was never queued.
   *
   * Because a batch can hold several handoffs, each later target is judged against a
   * PROJECTION of the state (`rounds`/`chain` advanced by every allowed target)
   * instead of the snapshot alone. Judging them all against the snapshot would let
   * one reply burn five rounds at once and dispatch the same agent twice in a batch.
   *
   * Returns null when there is nothing to guard: no RoomStore wired, no `groupId`, or
   * the room is gone. A null plan leaves the pure P6 path untouched.
   */
  function planRoomGuards(task: TaskRecord, handoffs: ResolvedHandoff[]): GuardPlan | null {
    if (!rooms || !task.groupId) return null;
    const room = rooms.getRoom(task.groupId);
    if (!room) return null;
    const state = rooms.getState(room.id);
    const kept: ResolvedHandoff[] = [];
    const blocked: GuardPlan["blocked"] = [];
    let rounds = state.roundCount;
    let chain = state.chain;
    let reachesCap = false;
    for (const handoff of handoffs) {
      const decision = evaluateTrigger({ ...state, roundCount: rounds, chain }, room, handoff.toMemberId);
      if (!decision.allowed) {
        const name = rooms.getAgent(handoff.toMemberId)?.name ?? handoff.toMemberId;
        blocked.push({ memberId: handoff.toMemberId, reason: formatBlockReason(name, decision) });
        continue;
      }
      kept.push(handoff);
      rounds += 1;
      chain = [...chain, handoff.toMemberId];
      // The trigger that lands exactly ON the cap is the one that schedules the
      // forced ending, not the ones after it (which are refused by ROUND_CAP).
      if (decision.reachesCap) reachesCap = true;
    }
    return { roomId: room.id, room, kept, blocked, reachesCap, rounds };
  }

  /**
   * Write the plan inside the caller's transaction: one round per handoff that
   * survived, and a system message for each that did not — AC4.1's "在流中显示系统
   * 消息" only holds if the refusal lands together with the refusal.
   */
  function applyRoomGuards(plan: GuardPlan): void {
    if (!rooms) return;
    for (const handoff of plan.kept) {
      rooms.recordTrigger(plan.roomId, handoff.toMemberId, now());
    }
    for (const block of plan.blocked) {
      rooms.appendMessage({ roomId: plan.roomId, authorKind: "system", content: block.reason }, now());
    }
  }

  /**
   * AC5.1 — hitting the cap is not just a refusal, it is a forced ending. The Task
   * is queued by the shared `queueWrapUpTask`, because a user message that mentions
   * enough agents consumes the same budget as a chain of handoffs and AC5.1 does not
   * distinguish the two: one implementation, or the two entry points drift.
   *
   * Called after the reply and the termination check, so if this very reply already
   * ended the room there is nothing to force (the helper re-reads the flag itself).
   */
  function queueWrapUpIfNeeded(task: TaskRecord, plan: GuardPlan): void {
    if (!rooms || !plan.reachesCap) return;
    queueWrapUpTask(rooms, store, {
      room: plan.room,
      rounds: plan.rounds,
      tenantId: task.tenantId,
      projectId: task.projectId,
      workspacePath: task.workspacePath,
      now: now(),
    });
  }

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
      // Q18: resume the original session when the runtime supports it. Only a
      // retry resumes; the first Attempt has no session yet. The file must still
      // exist, otherwise Pi would start from an empty history silently.
      //
      // Q31 — the group-chat path NEVER resumes: `groupId` forces this false. Each
      // trigger is a clean process that gets the room history re-injected (I4), so a
      // resumed Pi session would hand the same messages over twice. Crash/retry
      // replay works by injecting the same history again, not by restoring Pi's
      // internal state. Session resume stays a Pi adapter capability that Tasks
      // without a room still use.
      const resumeSession = !task.groupId && attempt.sequence > 1
        && adapter.capabilities.sessionResume
        && task.sessionFile && existsSync(task.sessionFile);
      const handle = await adapter.start({
        runId: attempt.id, tenantId: task.tenantId, projectId: task.projectId,
        memberId: task.memberId, workspacePath: task.workspacePath, prompt,
        // I3: persona dir is per-run. Only the runtime that reports agentDirPerRun
        // consumes it; the rest ignore it and keep using workspacePath.
        ...(task.agentDir ? { agentDir: task.agentDir } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(resumeSession
          ? { session: {
              sessionId: basename(task.sessionFile!, ".jsonl"),
              sessionDir: dirname(task.sessionFile!),
              sessionPath: task.sessionFile!,
              resume: true,
            } }
          : {}),
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
        // Persist the session before deciding the outcome: a failed or cancelled
        // Attempt must still let the next one resume with its history (Q18).
        if (result.sessionFile) {
          store.recordSession(attempt.id, attempt.fencingToken, result.sessionFile);
        }
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
      // One commit for both facts: a Task that succeeded without its reply in the
      // room — or a reply for a Task that did not succeed — would desynchronise the
      // stream the next trigger injects. `completeSuccess` joins this transaction
      // instead of nesting a second one.
      //
      // I6: the flow guards run inside the SAME transaction, after the state has
      // been read under the write lock. A room-guard refusal is not a runtime
      // failure: the Task still succeeded and still said what it said — only the
      // handoff it asked for is dropped, with a system message as the answer.
      store.transaction(() => {
        const plan = planRoomGuards(task, handoffs);
        store.completeSuccess(attempt.id, attempt.fencingToken, structured, plan ? plan.kept : handoffs, now());
        const spoke = appendAgentReply(task, structured);
        // A Task whose reply is already in the stream has already had its whole
        // effect committed (`spoke` is the idempotency marker), so the flow-state
        // writes below run exactly once per Task: rounds are not counted twice and
        // no system message is duplicated.
        if (!plan || !spoke) return;
        // The order below is the order the room reads in: reply, then the guard's
        // notes about what it refused, then the forced ending if this hit the cap.
        applyRoomGuards(plan);
        applyTermination(task, structured);
        queueWrapUpIfNeeded(task, plan);
      });
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
