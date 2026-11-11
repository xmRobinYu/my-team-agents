/**
 * P9a.5 cron — "定时即事件".
 *
 * The PRD's reference (`ref/AIHOT/apps/worker/src/schedules.ts`) does not give
 * timers their own execution path: a schedule is DATA (`{name, cron, missed, run}`),
 * and a tick that fires it produces an ordinary unit of work. This file keeps that
 * shape — a due schedule EMITS AN INBOUND EVENT, so a scheduled task and a webhook
 * task are the same Task, with the same lease/retry/recovery (AC4.1).
 *
 * Time zone: Beijing, as the reference uses. Asia/Shanghai has had no DST since
 * 1991, so a fixed +8h offset is exact — and it keeps this module free of a tz
 * database, which a 5-field cron parser does not justify.
 *
 * Bounded on purpose: star, N, ranges N-M, steps star-slash-N (and N-M/S), and lists
 * `a,b`. No `@reboot`, no seconds field, no `L`/`W`. A cron expression this parser
 * cannot read is REJECTED at rule registration, so a schedule is either understood
 * or refused — never silently never-firing.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0 = Sunday)
];

function parseField(field: string, index: number): number[] | null {
  const { min, max } = RANGES[index]!;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (piece === "") return null;
    const slash = piece.indexOf("/");
    const rangePart = slash === -1 ? piece : piece.slice(0, slash);
    const stepPart = slash === -1 ? undefined : piece.slice(slash + 1);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) return null;

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min; end = max;
    } else {
      const bounds = rangePart.split("-");
      if (bounds.length > 2) return null;
      const first = Number(bounds[0]);
      const second = bounds.length === 2 ? Number(bounds[1]) : first;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return null;
      start = first; end = second;
      // A single number with a step (`5/2`) is out of cron's grammar; refuse it
      // rather than guess whether it means `5,7,9…` or just `5`.
      if (bounds.length === 1 && stepPart !== undefined) return null;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

export type CronParseResult =
  | { ok: true; fields: CronFields }
  | { ok: false; message: string };

/** Parse a 5-field cron expression, or explain why it cannot be read. */
export function parseCron(expression: string): CronParseResult {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, message: "cron 需要 5 个字段：分 时 日 月 周（不支持秒）" };
  }
  const parsed: number[][] = [];
  for (let i = 0; i < 5; i += 1) {
    const field = parseField(parts[i]!, i);
    if (field === null) {
      const names = ["分(0-59)", "时(0-23)", "日(1-31)", "月(1-12)", "周(0-6, 0=周日)"];
      return { ok: false, message: `第 ${i + 1} 个字段无法解析（${names[i]}）：${parts[i]}` };
    }
    parsed.push(field);
  }
  return {
    ok: true,
    fields: {
      minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!,
      month: parsed[3]!, dayOfWeek: parsed[4]!,
    },
  };
}

/** Beijing calendar components for one instant. */
export function beijingParts(at: number): { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number } {
  const shifted = new Date(at + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

/**
 * How far back a scan may walk, in minutes. A year covers every calendar schedule
 * this parser accepts (the sparsest is Feb 29, which needs at most 4 years — but a
 * schedule that fires less than yearly is not a use case, and an UNBOUNDED walk is
 * a real hazard: a `cron_state` restored from an old database, or a clock that
 * jumped forward, would otherwise make the worker scan tens of millions of minutes
 * and stall. Bounded, and the bound is documented.)
 */
export const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/**
 * Every minute boundary in `(from, to]` whose Beijing time matches the schedule.
 *
 * Forward scan, bounded by `maxMinutes` so a caller passing a huge window pays a
 * capped cost instead of an unbounded one.
 */
export function dueSlots(
  fields: CronFields,
  from: number,
  to: number,
  maxMinutes = MAX_LOOKBACK_MINUTES,
): number[] {
  if (to <= from) return [];
  const slots: number[] = [];
  // Walk minute boundaries. `from` may sit mid-minute; the first candidate is the
  // next boundary strictly after it, because a slot already passed is a slot the
  // caller has seen.
  const earliest = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = Math.floor(to / 60_000) * 60_000;
  let cursor = Math.max(earliest, limit - maxMinutes * 60_000);
  for (; cursor <= limit; cursor += 60_000) {
    const parts = beijingParts(cursor);
    if (!fields.minute.includes(parts.minute)) continue;
    if (!fields.hour.includes(parts.hour)) continue;
    if (!fields.month.includes(parts.month)) continue;
    // Standard cron rule: when BOTH day-of-month and day-of-week are restricted, a
    // match on EITHER fires. When one is `*`, only the other constrains.
    const domRestricted = !(fields.dayOfMonth.length === RANGES[2]!.max - RANGES[2]!.min + 1);
    const dowRestricted = !(fields.dayOfWeek.length === 7);
    const domHit = fields.dayOfMonth.includes(parts.day);
    const dowHit = fields.dayOfWeek.includes(parts.dayOfWeek);
    const dayOk = domRestricted && dowRestricted
      ? domHit || dowHit
      : domRestricted ? domHit
        : dowRestricted ? dowHit
          : true;
    if (!dayOk) continue;
    slots.push(cursor);
  }
  return slots;
}

/**
 * The slot the scheduler should treat as "the one that is due".
 *
 * `missed: "once"` (the PRD's explicit choice, from the reference): after downtime,
 * only the MOST RECENT missed slot fires. Replaying a burst of stale slots would
 * turn a restart into an event storm; skipping them all would silently drop the
 * work. One is the honest middle.
 */
export function latestDueSlot(
  fields: CronFields,
  from: number,
  to: number,
  maxMinutes = MAX_LOOKBACK_MINUTES,
): number | null {
  // Scan BACKWARD from `to` and stop at the first match. Most schedules match within
  // a day, so the common cost is a few thousand iterations rather than the full
  // window; a sparse one stops at the cap. Forward-scanning the whole window to keep
  // the LAST slot would do the maximum work to learn the least.
  const floor = Math.max(
    Math.floor(from / 60_000) * 60_000 + 60_000,
    Math.floor(to / 60_000) * 60_000 - maxMinutes * 60_000,
  );
  for (let cursor = Math.floor(to / 60_000) * 60_000; cursor >= floor; cursor -= 60_000) {
    const parts = beijingParts(cursor);
    if (!fields.minute.includes(parts.minute)) continue;
    if (!fields.hour.includes(parts.hour)) continue;
    if (!fields.month.includes(parts.month)) continue;
    const domRestricted = !(fields.dayOfMonth.length === RANGES[2]!.max - RANGES[2]!.min + 1);
    const dowRestricted = !(fields.dayOfWeek.length === 7);
    const domHit = fields.dayOfMonth.includes(parts.day);
    const dowHit = fields.dayOfWeek.includes(parts.dayOfWeek);
    const dayOk = domRestricted && dowRestricted
      ? domHit || dowHit
      : domRestricted ? domHit
        : dowRestricted ? dowHit
          : true;
    if (dayOk) return cursor;
  }
  return null;
}

/** The event id for one schedule slot. Stable, so a re-tick of the same slot dedups. */
export function cronEventId(ruleId: string, slotMs: number): string {
  return `cron:${ruleId}:${slotMs}`;
}
