/**
 * AC4.3 — template `cronTasks` become RULES, not `ignoredFields`.
 *
 * Upstream ships each scheduled task as
 * `{id,name,description,scheduleType,cronExpression,intervalMinutes,scheduledAt,
 * payload,agentIds,enabled,maxRetries}` (measured against
 * `ref/teamagentx-templates/*.zip`). The PRD's P9.5 row asks for exactly one thing:
 * a template that declares a schedule must stop landing in the ignore list.
 *
 * This module is the PURE mapping. It is separate from `template-import.ts` because
 * the importer talks only to a `RoomStore`, and rule registration needs the
 * `IngestStore` — keeping the mapping pure lets it be tested against the real zips
 * without a database, and lets the importer accept registration as an OPTIONAL seam
 * (a caller with no ingest store still gets the converted rules reported, not lost).
 *
 * Two upstream shapes are NOT schedules and are refused BY NAME rather than skipped:
 *  - `scheduleType: "once"` with `scheduledAt` — a one-shot at a wall-clock time,
 *    which this cron model does not express. Refusing it is honest; silently
 *    converting it to a daily job would fire the work forever.
 *  - `intervalMinutes` without a cron expression — an interval, not a calendar
 *    slot. Also refused, for the same reason.
 *
 * `payload` becomes the rule's `ask`. That is safe specifically because a template is
 * operator-authored, trusted content: `ask` is the instruction voice by design, while
 * an EVENT's body is the untrusted data voice (`buildEventPrompt`). A cron tick
 * carries no external bytes, so nothing here widens what a rule can be made to do.
 */

import { createHash } from "node:crypto";
import { parseCron } from "./cron.js";
import type { TriggerRuleInput } from "./ingest.js";

/** One `cronTasks[]` entry as upstream writes it. All fields optional but `id`. */
export interface TemplateCronTask {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  scheduleType?: unknown;
  cronExpression?: unknown;
  intervalMinutes?: unknown;
  scheduledAt?: unknown;
  payload?: unknown;
  agentIds?: unknown;
  enabled?: unknown;
}

export interface CronRulePlan {
  /** Rules ready to register, in template order. */
  rules: TriggerRuleInput[];
  /** Tasks that could not be converted, each with the reason — never dropped. */
  refused: Array<{ name: string; reason: string }>;
}

export interface CronRuleContext {
  /**
   * Maps a template agent id (`cronTasks[].agentIds[]`) to the member id a rule
   * needs. Returns null for an unknown template id, which makes that task a
   * refusal: a rule pointing at a member that does not exist is exactly the silent
   * mis-dispatch AC1.3 exists to stop.
   */
  memberIdForTemplateAgent: (templateAgentId: string) => string | null;
  /** Project workspace the scheduled Tasks run against. */
  workspacePath: string;
  /** Which snapshot agent id the schedule addresses. */
  agentIdOf: (task: TemplateCronTask) => string | null;
  /** Lane prefix, so a template's schedules serialise per (name). */
  lanePrefix?: string;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function slug(text: string): string {
  // The lane reaches SQL as a serialisation key and must match `LANE_PATTERN`, so
  // an all-Chinese task name cannot be the lane itself. Keep any ASCII words.
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii === "" ? "" : ascii.slice(0, 24);
}

/**
 * The lane for one template schedule.
 *
 * Bounded and collision-resistant on purpose. The obvious `"${roomRef}:${slug}"`
 * is wrong twice over: `roomRef` is a 36-char uuid, so a longer task name pushes the
 * lane past `LANE_PATTERN`'s 64-char cap and the rule is then REFUSED AT
 * REGISTRATION — a template that imports fine would produce no working schedule. And
 * keying on the name alone would make two different templates' "Git周报" share a
 * lane, so their Tasks would serialise against each other.
 *
 * So: a short readable slug plus a hash of the FULL identity (prefix + name + id).
 * The hash is what makes distinct schedules distinct; the slug is what makes the key
 * diagnosable in a log.
 */
function laneFor(prefix: string, name: string, id: string): string {
  const digest = createHash("sha256").update(`${prefix}\x1f${name}\x1f${id}`).digest("hex").slice(0, 10);
  const head = slug(name) || slug(id) || "job";
  // 10 (hash) + 1 (:) + up to 24 (slug) is 35, comfortably inside the 64 cap.
  return `${head}-${digest}`;
}

/**
 * Map every `cronTasks[]` entry of a template to a rule input.
 *
 * Deterministic and total: every input task produces EITHER a rule OR a refusal.
 * The importer records the refusals in its report, so a schedule that could not be
 * migrated is visible rather than assumed working.
 */
export function planCronRules(
  tasks: readonly TemplateCronTask[],
  context: CronRuleContext,
): CronRulePlan {
  const rules: TriggerRuleInput[] = [];
  const refused: CronRulePlan["refused"] = [];

  for (const task of tasks) {
    const name = str(task.name) || str(task.id) || "(未命名定时任务)";
    const payload = str(task.payload);
    if (payload === "") {
      refused.push({ name, reason: "payload 为空：没有指令的定时任务无法变成规则（没有 ask）" });
      continue;
    }
    const scheduleType = str(task.scheduleType) || "cron";
    if (scheduleType !== "cron") {
      refused.push({
        name,
        reason: `scheduleType=${scheduleType} 不是 cron：一次性/间隔触发不在 P9a 的日历模型内，不能猜成定时任务`,
      });
      continue;
    }
    const expression = str(task.cronExpression);
    if (expression === "") {
      refused.push({ name, reason: "缺少 cronExpression（intervalMinutes 这类间隔不属于日历槽位）" });
      continue;
    }
    const parsed = parseCron(expression);
    if (!parsed.ok) {
      refused.push({ name, reason: `cronExpression 无法解析：${parsed.message}` });
      continue;
    }
    const templateAgentId = str(context.agentIdOf(task));
    const memberId = templateAgentId === "" ? null : context.memberIdForTemplateAgent(templateAgentId);
    if (memberId === null) {
      refused.push({
        name,
        reason: templateAgentId === ""
          ? "没有 agentIds：定时任务不知道该交给谁（规则必须有 to.memberId）"
          : `agentIds 指向包内不存在的 agent：${templateAgentId}`,
      });
      continue;
    }

    rules.push({
      name: `模板定时：${name}`,
      enabled: task.enabled === undefined ? true : task.enabled === true,
      priority: 0,
      when: { sources: ["cron"], types: ["scheduled.tick"] },
      to: { memberId, workspacePath: context.workspacePath },
      ask: payload,
      lane: laneFor(`${context.lanePrefix ?? "cron"}`, name, str(task.id)),
      cron: { expression, type: "scheduled.tick" },
      tell: "silent",
      dedup: { windowMs: 0 },
    });
  }

  return { rules, refused };
}

/**
 * Pull the `cronTasks` array out of a parsed snapshot without trusting its shape.
 * A non-array is reported as "no schedules", not thrown: a malformed optional field
 * must not fail an otherwise importable package.
 */
export function readCronTasks(snapshot: unknown): TemplateCronTask[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const raw = (snapshot as Record<string, unknown>)["cronTasks"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is TemplateCronTask =>
    typeof entry === "object" && entry !== null);
}
