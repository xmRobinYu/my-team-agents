/**
 * P9a.5 scheduler — the tick that turns due cron slots into inbound events.
 *
 * Deliberately NOT a second execution path (AC4.1): a due slot is an event with
 * `source: "cron"`, fed through the SAME `IngestService.submit`. So a scheduled task
 * gets the same lease, retries, recovery and cost attribution as a webhook task,
 * and there is exactly one place where "an event becomes a Task" is decided.
 *
 * Idempotence is two-layered (AC4.2), because either layer alone is insufficient:
 *  - the persisted `cron_state.last_slot` stops a re-tick from re-offering a slot
 *    the scheduler already advanced past, even across a restart;
 *  - the event id `cron:<ruleId>:<slotMs>` is stable, so even if the first layer is
 *    lost (a database restored from before the write), `IngestService`'s
 *    delivery-level dedup returns the original answer instead of a second Task.
 *
 * `missed: "once"`: after downtime only the MOST RECENT missed slot fires. A restart
 * must not replay a burst of stale slots into the queue.
 */

import type { IngestService } from "./ingest-service.js";
import type { IngestStore } from "./ingest-store.js";
import type { EventScope, InboundEvent } from "./ingest.js";
import { cronEventId, latestDueSlot, parseCron } from "./cron.js";

export interface SchedulerDeps {
  ingest: IngestStore;
  service: IngestService;
  scope: EventScope;
  now?: () => number;
}

export interface Scheduler {
  /** Fire every schedule whose latest due slot is newer than its recorded state. */
  tick(at?: number): number;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { ingest, service, scope } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    tick(at = now()) {
      let fired = 0;
      for (const rule of ingest.listEnabledRules()) {
        if (!rule.cron) continue;
        const parsed = parseCron(rule.cron.expression);
        // A stored rule's expression was validated at registration, so a parse
        // failure here can only mean the stored text is corrupt. Skip it rather than
        // throwing: one bad row must not stop every other schedule.
        if (!parsed.ok) continue;

        const last = ingest.getCronState(rule.id);
        if (last === null) {
          // First sight of a brand-new rule: seed the cursor to now so the schedule
          // starts from the NEXT slot instead of replaying history since the epoch.
          ingest.setCronState(rule.id, Math.floor(at / 60_000) * 60_000);
          continue;
        }
        const slot = latestDueSlot(parsed.fields, last, at);
        if (slot === null) continue;

        const event: InboundEvent = {
          id: cronEventId(rule.id, slot),
          source: "cron",
          type: rule.cron.type,
          // The schedule itself is the object key: two ticks of one rule are the
          // same work, and later ones coalesce onto the Task the first one started.
          subject: rule.id,
          summary: `定时触发：${rule.name}（${rule.cron.expression}）`,
          occurredAt: slot,
          payload: { ruleId: rule.id, name: rule.name, expression: rule.cron.expression, slot },
          truncated: { summary: false, detail: false },
        };
        service.submit(event, scope);
        ingest.setCronState(rule.id, slot);
        fired += 1;
      }
      return fired;
    },
  };
}
