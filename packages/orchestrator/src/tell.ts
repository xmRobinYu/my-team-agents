/**
 * P9b — consuming `tell`.
 *
 * `tell` has been stored on the rule since P9a and did nothing. This is the出站 half:
 * when a Task ends in a state a human must decide about, the rule's `tell` decides
 * whether to say so — ONCE.
 *
 * Three decisions worth stating:
 *
 *   1. "定过的事不问第二遍" is enforced by a LEDGER, not by remembering. The dedup key
 *      is `(rule, subject, kind)`: the same event's subject failing twice does not
 *      page twice, and a worker restart does not page again. At-most-once is the
 *      right bias for a notification — a missed page is annoying, a pager storm at
 *      3am is worse.
 *   2. ONE channel. The PRD says 单一出站通道; a second transport is how notification
 *      systems grow divergent retry semantics. `TellChannel` is the seam, and the
 *      worker wires exactly one.
 *   3. A cooldown per rule, so a rule that fails every minute cannot page every
 *      minute. It is a separate mechanism from the ledger: the ledger is identity,
 *      the cooldown is rate.
 *
 * The channel is injected, so the default in a deployment that has configured
 * nothing is silence — never an accidental outbound request.
 */

import type { ExecutionStore, TaskRecord } from "./execution-store.js";
import type { IngestStore } from "./ingest-store.js";

export interface TellCard {
  /** Why we are telling anyone. */
  kind: "blocked" | "failed";
  title: string;
  ruleId: string;
  ruleName: string;
  taskId: string;
  memberId: string;
  /** The event's object key — what this is about, in the producer's terms. */
  subject: string;
  eventId: string | null;
  reason: string;
  at: number;
}

export interface TellChannel {
  /** Stable name, recorded in the ledger so the transport is auditable. */
  readonly name: string;
  send(card: TellCard): Promise<void>;
}

/** Default: configured nothing, send nothing. */
export const SILENT_CHANNEL: TellChannel = {
  name: "silent",
  async send() { /* deliberately nothing */ },
};

/**
 * POST the card as JSON to one webhook. Feishu's custom-bot webhook accepts a
 * `{ msg_type, content }` envelope, so this doubles as the 飞书卡片 channel without
 * hard-coding a vendor SDK: the payload is explicit and inspectable.
 */
export function createWebhookChannel(url: string, options: { timeoutMs?: number } = {}): TellChannel {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: `webhook:${new URL(url).host}`,
    async send(card) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msg_type: "text",
          content: { text: `${card.title}\n${card.reason}\nTask: ${card.taskId}` },
          card,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A webhook that answers 500 has NOT delivered: throwing keeps the ledger
      // entry un-sent so a later pass can retry it.
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    },
  };
}

const DEFAULT_COOLDOWN_MS = 10 * 60_000;

export interface TellServiceDeps {
  executions: ExecutionStore;
  ingest: IngestStore;
  channel: TellChannel;
  /** Minimum gap between two sent notices for the same rule. */
  cooldownMs?: number;
  now?: () => number;
}

export interface TellService {
  /** Notify about one settled Task. Safe to call repeatedly. */
  notify(taskId: string): Promise<void>;
}

/**
 * Resolve which rules want to be told, then send at most once each.
 *
 * A Task knows its `eventId`; the event knows which rules matched it. A Task
 * created without an event (a manual `/api/tasks` POST) has no rule, so `tell`
 * does not apply — silence, not a guessed recipient.
 */
export function createTellService(deps: TellServiceDeps): TellService {
  const { executions, ingest, channel } = deps;
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  function cardFor(task: TaskRecord, ruleId: string, ruleName: string, kind: TellCard["kind"], subject: string): TellCard {
    return {
      kind,
      title: kind === "blocked" ? `【需人工决策】${ruleName}` : `【任务失败】${ruleName}`,
      ruleId,
      ruleName,
      taskId: task.id,
      memberId: task.memberId,
      subject,
      eventId: task.eventId ?? null,
      reason: task.error ?? "(no error recorded)",
      at: now(),
    };
  }

  return {
    async notify(taskId) {
      const task = executions.getTask(taskId);
      if (!task?.eventId) return;
      if (task.status !== "blocked" && task.status !== "failed") return;

      const record = ingest.getEvent(task.eventId);
      if (!record) return;

      const kind: TellCard["kind"] = task.status === "blocked" ? "blocked" : "failed";
      for (const ruleId of record.ruleIds) {
        const rule = ingest.getRule(ruleId);
        // `silent` means silent. This is the whole point of the field.
        if (!rule || rule.tell !== "needed") continue;

        // Identity first: has THIS (rule, subject, kind) already been said?
        const dedupKey = `tell:${rule.id}:${record.event.subject}:${kind}`;
        const claimed = ingest.claimTell(dedupKey, rule.id, task.id, kind, channel.name, now());
        if (!claimed) continue;

        // Then rate. A separate check because the ledger is identity, not throttle.
        const last = ingest.lastTellSentAt(rule.id);
        if (last !== null && now() - last < cooldownMs) {
          // Release the claim: this was NOT sent, so a later window may still send it.
          ingest.releaseTell(dedupKey);
          continue;
        }

        try {
          await channel.send(cardFor(task, rule.id, rule.name, kind, record.event.subject));
          ingest.finishTell(dedupKey, "sent", null, now());
        } catch (err) {
          ingest.finishTell(dedupKey, "failed", err instanceof Error ? err.message : String(err), now());
        }
      }
    },
  };
}
