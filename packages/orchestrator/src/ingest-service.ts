/**
 * P9a ingestion service — the decision: delivered / coalesced / dispatched /
 * deferred / unmatched.
 *
 * The judgement order is a CONTRACT, not an implementation detail (same framing as
 * `room-guards.ts`'s "fixed order"), because each step can suppress the next:
 *
 *   1. delivered  — the same `(source, id)` was already seen. Returns the ORIGINAL
 *                   event and its Tasks. Nothing new is created.
 *   2. unmatched  — no rule claimed it. The event is still recorded (G5).
 *   3. per matching rule, highest priority first:
 *        coalesced  — a live Task already owns `(rule, lane, subject)`: this event
 *                     JOINS it. That is the difference between "one more opinion on
 *                     the same thing" and "wake another agent".
 *        deferred   — the rule's rate window is full. NOT dropped: the event row
 *                     keeps `outcome=deferred` and a `retry_at`, and the scheduler's
 *                     redrive pass re-offers it. A deferred event that could never
 *                     be retried would be a silent drop with extra steps.
 *        dispatched — a new Task.
 *
 * One recorded outcome per event (`互斥`, PRD §5.2) even when several rules match:
 * `dispatched` outranks `coalesced` outranks `deferred`.
 *
 * The whole decision runs in ONE transaction owned by the `ExecutionStore`, so the
 * event row, the Tasks it produced and the outcome commit together — the same rule
 * `postRoomMessage` follows. A crash between "Task created" and "outcome written"
 * would otherwise leave an event that claims it dispatched nothing.
 */

import type { ExecutionStore, TaskRecord } from "./execution-store.js";
import type { IngestStore, InboundEventRecord } from "./ingest-store.js";
import type {
  EventScope,
  InboundEvent,
  IngestOutcome,
  TriggerRule,
  TriggerRuleInput,
} from "./ingest.js";
import { buildEventPrompt, normalizeEvent, orderMatches, validateRuleInput } from "./ingest.js";

/** Terminal Task states: a Task in one of these no longer owns its lane. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "blocked"]);

/** A deferral must be re-offered; this is how soon. Kept short so a redrive test is real. */
const DEFER_RETRY_MS = 1_000;

export interface IngestServiceDeps {
  executions: ExecutionStore;
  ingest: IngestStore;
  /**
   * AC1.3 — does this member id exist? Injected so the pure validator stays pure
   * and the caller decides what counts as a roster (a RoomAgent, an execution
   * member, or both). The failure it prevents is concrete: a free-form model string
   * reached dispatch as `member_id="寇豆码"`/`agent_dir=NULL` and spun anonymously.
   */
  memberExists: (memberId: string) => boolean;
  now?: () => number;
}

export interface SubmitResult {
  /** 200 for a delivery (new OR repeated), 4xx only for a malformed body. */
  status: 200 | 400;
  outcome: IngestOutcome;
  event?: InboundEventRecord;
  taskIds: string[];
  ruleIds: string[];
  coalescedInto?: string;
  /** Why the body was refused, when `status === 400`. */
  errors?: Array<{ field: string; code: string; message: string }>;
}

export interface RegisterRuleResult {
  ok: boolean;
  rule?: TriggerRule;
  errors?: Array<{ field: string; code: string; message: string }>;
}

export interface IngestService {
  submit(body: unknown, scope: EventScope): SubmitResult;
  registerRule(input: TriggerRuleInput, scope?: Partial<EventScope>): RegisterRuleResult;
  /** Re-offer deferred events whose window has passed. Returns how many progressed. */
  redriveDeferred(now?: number): number;
}

export function createIngestService(deps: IngestServiceDeps): IngestService {
  const { executions, ingest, memberExists } = deps;
  const now = deps.now ?? (() => Date.now());

  if (executions.db !== ingest.db) {
    throw new Error("IngestService needs the ExecutionStore and IngestStore over one database handle");
  }

  /**
   * The live Task that owns `(rule, lane, subject)`, if any. Empty `subject` means
   * "no object key", so it never coalesces: collapsing every subject-less event of a
   * rule into one Task would be a merge the producer never asked for.
   */
  function liveOwner(rule: TriggerRule, subject: string, scope: EventScope): TaskRecord | null {
    if (subject === "") return null;
    const candidate = ingest.laneClaim(rule.id, rule.lane, subject);
    if (!candidate) return null;
    const task = executions.getTask(candidate);
    if (!task || TERMINAL.has(task.status)) return null;
    return task;
  }

  /** Dispatched-or-coalesced events for this rule inside its rate window. */
  function withinRateLimit(rule: TriggerRule, at: number): boolean {
    const rate = rule.rate;
    if (!rate) return true;
    const used = ingest.countDispatchesSince(rule.id, at - rate.windowMs);
    return used < rate.max;
  }

  function dispatchEvent(event: InboundEvent, scope: EventScope): Pick<SubmitResult, "outcome" | "taskIds" | "ruleIds" | "coalescedInto"> {
    const at = now();
    const matched = orderMatches(ingest.listEnabledRules(), event, scope);
    if (matched.length === 0) return { outcome: "unmatched", taskIds: [], ruleIds: [] };

    const taskIds: string[] = [];
    const ruleIds: string[] = [];
    let sawDispatch = false;
    let sawCoalesce = false;
    let sawDefer = false;
    let coalescedInto: string | undefined;

    for (const rule of matched) {
      ruleIds.push(rule.id);
      const owner = liveOwner(rule, event.subject, scope);
      if (owner) {
        // AC2.2/AC2.3: fold into the running Task. Its `available_at` is deferred so
        // the new material is read on the NEXT attempt of that Task rather than
        // racing the one already in flight (the PRD's "复用 available_at 推迟").
        ingest.linkCoalesced(event.id, owner.id, at);
        // `deferTask` pushes `available_at` so the NEXT attempt of that Task reads
        // this material, instead of racing the attempt already in flight.
        executions.deferTask(owner.id, at);
        taskIds.push(owner.id);
        coalescedInto = coalescedInto ?? owner.id;
        sawCoalesce = true;
        continue;
      }
      if (!withinRateLimit(rule, at)) {
        sawDefer = true;
        continue;
      }
      // AC3.4 + Q18: `lane` is NOT `groupId`. A `groupId` would make the worker force
      // `resumeSession = false` (Q31, durable-worker.ts:616) and try to inject a Room
      // that does not exist. `lane` serialises without either side effect.
      const task = executions.createTask({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        memberId: rule.to.memberId,
        workspacePath: rule.to.workspacePath,
        prompt: buildEventPrompt(rule, event),
        lane: rule.lane,
        eventId: event.id,
        // AC5.2: carry the allowlist to the run. Validated at registration; passed
        // here so "read-only" is a property of the execution, not just the rule row.
        tools: rule.to.tools,
        // AC2.1: the idempotency key is the EVENT, so a redrive of the same event
        // cannot mint a second Task even if the coalesce check races.
        idempotencyKey: `event:${event.id}:${rule.id}`,
      }, at);
      ingest.claimLane(rule.id, rule.lane, event.subject, task.id, at);
      ingest.recordDispatch(rule.id, event.id, task.id, at);
      taskIds.push(task.id);
      sawDispatch = true;
    }

    const outcome: IngestOutcome = sawDispatch ? "dispatched" : sawCoalesce ? "coalesced" : sawDefer ? "deferred" : "unmatched";
    return { outcome, taskIds, ruleIds, ...(coalescedInto ? { coalescedInto } : {}) };
  }

  return {
    submit(body, scope) {
      const at = now();
      const normalized = normalizeEvent(body, { now: at });
      if (!normalized.ok) {
        return { status: 400, outcome: "rejected", taskIds: [], ruleIds: [],
          errors: [{ field: normalized.code === "SUMMARY_REQUIRED" ? "summary" : normalized.code === "TYPE_REQUIRED" ? "type" : "source",
            code: normalized.code, message: normalized.message }] };
      }
      const event = normalized.event;

      return executions.transaction(() => {
        // AC2.1/AC2.4: a repeated delivery is a 200 with the original answer.
        const inserted = ingest.insertEvent(event, scope, "unmatched", at);
        if (!inserted.inserted) {
          const record = inserted.record;
          ingest.setEventOutcome(record.event.id, "delivered");
          return {
            status: 200 as const,
            outcome: "delivered" as const,
            event: { ...record, outcome: "delivered" as const },
            taskIds: record.taskIds,
            ruleIds: record.ruleIds,
          };
        }

        const decision = dispatchEvent(event, scope);
        ingest.setEventOutcome(event.id, decision.outcome, {
          ruleIds: decision.ruleIds,
          taskIds: decision.taskIds,
          coalescedInto: decision.coalescedInto ?? null,
        });
        if (decision.outcome === "deferred") {
          ingest.scheduleRetry(event.id, at + DEFER_RETRY_MS);
        }
        const record = ingest.getEvent(event.id)!;
        return {
          status: 200 as const,
          outcome: decision.outcome,
          event: record,
          taskIds: decision.taskIds,
          ruleIds: decision.ruleIds,
          ...(decision.coalescedInto ? { coalescedInto: decision.coalescedInto } : {}),
        };
      });
    },

    registerRule(input, scope = {}) {
      // AC1.3: reject AT REGISTRATION, not by degrading at dispatch.
      const validated = validateRuleInput(
        { ...input, tenantId: input.tenantId ?? scope.tenantId, projectId: input.projectId ?? scope.projectId },
        memberExists,
      );
      if (!validated.ok) return { ok: false, errors: validated.errors };
      return { ok: true, rule: ingest.createRule(validated.value, now()) };
    },

    redriveDeferred(at = now()) {
      const due = ingest.dueRetries(at);
      let progressed = 0;
      for (const record of due) {
        executions.transaction(() => {
          // Re-run the decision WITHOUT re-inserting: the `(source, id)` dedup key
          // already holds this event, so `insertEvent` would report `delivered` and a
          // deferred event would never advance. Redrive is the only path that updates
          // an existing row's outcome.
          ingest.clearRetry(record.event.id);
          const decision = dispatchEvent(record.event, record.scope);
          ingest.setEventOutcome(record.event.id, decision.outcome, {
            ruleIds: decision.ruleIds,
            taskIds: decision.taskIds,
            coalescedInto: decision.coalescedInto ?? null,
          });
          if (decision.outcome === "deferred") {
            ingest.scheduleRetry(record.event.id, at + DEFER_RETRY_MS);
          }
          if (decision.outcome !== "deferred") progressed += 1;
        });
      }
      return progressed;
    },
  };
}
