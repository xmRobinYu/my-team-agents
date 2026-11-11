/**
 * Issue I2 — teamagentx 团队模板包解析与导入.
 *
 * A template package is a zip (`ref/teamagentx-templates/*.zip`) carrying a
 * whole-team snapshot:
 *
 *   manifest.json                 schemaVersion / templateId / version / title / contents
 *   snapshot.json                 room + agents[] + categories + cronTasks
 *   capability-descriptors.json   per-agent capability, keyed by `agentRef`
 *   skill-usages.json             `agentId` -> skill `slug`
 *   degraded-skills.json          skills upstream failed to export
 *   skills/<slug>/**              skill files, present only when contents.skills > 0
 *
 * Three phases, split so a caller can inspect before anything is committed:
 *
 *   parseTemplatePackage()   zip bytes -> validated snapshot (pure)
 *   planTemplateImport()     + agentDir layout and DB inputs (pure)
 *   importTemplatePackage()  write agentDirs -> one SQLite transaction
 *
 * Field policy (Q28/Q31 + the PRD risk row "模板包字段与我们的模型不匹配"):
 * fields we do not migrate (`speechConfig`, `proxyConfig`, `codexModel`,
 * `acpTool`, `categories`, `cronTasks`, ...) are never silently swallowed. Each
 * one lands in `ignoredFields` with a reason and a value preview; anything
 * suspicious lands in `warnings`. Both are also written to disk as
 * `import-report.json` so an import can be audited after the fact.
 *
 * Atomicity: persona dirs are written before the transaction, and any failure —
 * write or commit — removes every directory this import created. The room and
 * its agents commit in one transaction, so a bad package leaves neither a
 * half-imported room nor orphan persona directories.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatRoom, RoomAgent } from "@my-team-agents/domain";
import { PERSONA_SKILLS_DIR } from "@my-team-agents/runtime-core";
import type { CreateRoomAgentInput, CreateRoomInput, RoomStore } from "./room-store.js";
import { planCronRules, readCronTasks, type CronRulePlan } from "./ingest-import.js";
import type { TriggerRule } from "./ingest.js";
import type {
  ZipSource,
  TemplateErrorCode,
  IgnoredField,
  ImportWarning,
  CoordinatorSource,
  CoordinatorDecision,
  ParsedAgent,
  ParsedTemplate,
  PlannedAgent,
  PlannedImport,
  ImportResult,
  ParseOptions,
  ImportOptions,
} from "./template-types.js";
import { msg, str } from "./template-readers.js";
import {
  parseTemplatePackage,
  resolveCoordinator,
  sanitizeSegment,
} from "./template-parse.js";
import { TemplateImportError } from "./template-types.js";

// ---------------------------------------------------------------------------
// Public surface, unchanged.
//
// The implementation moved into `template-types` / `template-readers` /
// `template-parse` when this file crossed the repo's 800-line limit. Re-exporting
// here keeps every existing import site (`index.ts`, the tests) compiling and
// keeps one documented entry point for template import.
// ---------------------------------------------------------------------------

export type {
  ZipSource,
  TemplateErrorCode,
  IgnoredField,
  ImportWarning,
  CoordinatorSource,
  CoordinatorDecision,
  ParsedAgent,
  ParsedTemplate,
  PlannedAgent,
  PlannedImport,
  ImportResult,
  ParseOptions,
  ImportOptions,
} from "./template-types.js";
export { TemplateImportError } from "./template-types.js";
export { parseTemplatePackage, parseFrontmatter, resolveCoordinator } from "./template-parse.js";

// --- agentDir material -----------------------------------------------------

// --- agentDir material -----------------------------------------------------

/**
 * AGENTS.md is the Pi context file for the persona: identity + room rules + the
 * role prompt verbatim. We do not rewrite the prompt — inventing persona text
 * is worse than carrying upstream's exactly.
 */
export function renderAgentMd(parsed: ParsedTemplate, agent: ParsedAgent): string {
  const fm = agent.frontmatter;
  const lines: (string | null)[] = [
    `# ${agent.name}${agent.role ? `（${agent.role}）` : ""}`,
    "",
    `- 角色 id：\`${fm["name"] ?? agent.templateAgentId}\``,
    `- 描述：${fm["description"] ?? "（未声明）"}`,
    fm["vibe"] ? `- vibe：${fm["vibe"]}` : null,
    `- 来源模板包：\`${parsed.manifest.templateId}\` v\`${parsed.manifest.version || "0"}\``,
    `- 所属群：${parsed.room.name}${agent.skillSlugs.length > 0 ? `｜技能：${agent.skillSlugs.join(", ")}` : ""}`,
    "",
    "## 群聊行为",
    "",
    "- 你在多 Agent 群聊中以自己的身份发言，回复会被写进群共享消息流。",
    "- 群历史与角色 prompt 由平台在每次触发时注入；不要假设自己记得上一次对话。",
    "- 需要把活儿交给别的成员时，用结构化 `handoff_to`，或在正文里 `@成员名`。",
    "",
    "## 群规则（来自模板包 room.rules）",
    "",
    parsed.room.rules.trim() === "" ? "（包内未提供 rules）" : parsed.room.rules.trim(),
    "",
    "## 角色 prompt（模板包原文，含 frontmatter）",
    "",
    agent.prompt.trim() === "" ? "（prompt 为空，见导入报告 agent-prompt-empty）" : agent.prompt.trim(),
    "",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * Plan an import: layout, coordinator and DB inputs. Pure — touches neither
 * disk nor SQLite, so a caller can dry-run and show the report first.
 */
export function planTemplateImport(
  source: ZipSource,
  input: { projectId: string; roomsRoot?: string; parse?: ParseOptions; nonce?: string },
): PlannedImport {
  const parsed = parseTemplatePackage(source, input.parse ?? {});
  const coordinator = resolveCoordinator(parsed);
  if (input.projectId.trim() === "") {
    throw new TemplateImportError(
      "ROOM_INVALID",
      "projectId 不能为空：导入的 agent 必须绑定到一个 Project（Q34）",
    );
  }

  const roomsRoot = resolve(input.roomsRoot ?? resolve(process.cwd(), ".rooms"));
  // `<roomRef>-<nonce>`: the package's room id keeps the tree readable, the
  // nonce keeps repeated imports of the same package from clobbering each
  // other's persona dirs. The DB-generated ChatRoom id is not known yet —
  // RoomStore.createRoom mints it inside the transaction.
  const nonce = (input.nonce ?? randomUUID()).slice(0, 8);
  const roomRoot = join(roomsRoot, `${parsed.manifest.roomRef}-${nonce}`);

  const agents: PlannedAgent[] = parsed.agents.map((agent) => {
    const agentDir = join(roomRoot, "agents", sanitizeSegment(agent.templateAgentId, "agent"));
    // I9: the layout constant is shared with the loader (`PERSONA_SKILLS_DIR`),
    // because "the importer wrote it here" and "Pi looks there" must be the same
    // statement. These dirs are NOT discovered by Pi from cwd; they reach the run
    // through `--skill <dir>` in `runtime-pi` — see its `skills.ts` for the
    // measured comparison against `.pi/skills/`.
    const skillPaths = agent.skillSlugs.flatMap((slug) =>
      Object.keys(parsed.skillFiles[slug] ?? {}).map((rel) => `${PERSONA_SKILLS_DIR}/${slug}/${rel}`),
    );
    return {
      templateAgentId: agent.templateAgentId,
      agentDir,
      role: agent.role,
      skills: agent.skillSlugs,
      files: ["AGENTS.md", ".template-import.json", ...skillPaths],
      input: {
        name: agent.name,
        role: agent.role,
        prompt: agent.prompt,
        agentDir,
        model: null,
        thinkingMode: agent.thinkingMode,
        emoji: agent.emoji,
        color: agent.color,
        isCoordinator: agent.templateAgentId === coordinator.templateAgentId,
      },
    };
  });

  if (!agents.some((a) => a.input.isCoordinator)) {
    // Unreachable in practice — the coordinator is picked out of this same
    // list. If it ever fires the fallback rule broke; say so loudly instead of
    // silently producing a room with no coordinator.
    parsed.warnings.push({
      code: "coordinator-flag-missing",
      message: "内部错误：计划内没有任何 agent 被标记为协调者",
    });
  }

  const roomInput: CreateRoomInput = {
    projectId: input.projectId,
    name: parsed.room.name,
    description: parsed.room.description,
    rules: parsed.room.rules,
    // Left null on purpose: addAgent() sets coordinator_agent_id when it
    // inserts the flagged agent, so room and flag stay consistent by
    // construction rather than by duplicating an id here.
    coordinatorAgentId: null,
  };

  return {
    parsed,
    coordinator,
    roomInput,
    agents,
    roomRoot,
    ignoredFields: parsed.ignoredFields,
    warnings: parsed.warnings,
  };
}

/** Write one agent's persona directory. */
const writeAgentDir = (plan: PlannedImport, agent: PlannedAgent, marker: object): void => {
  const parsed = plan.parsed;
  const source = parsed.agents.find((a) => a.templateAgentId === agent.templateAgentId);
  if (!source) throw new TemplateImportError("AGENT_INVALID", `计划与解析结果不一致：${agent.input.name}`);
  mkdirSync(join(agent.agentDir, PERSONA_SKILLS_DIR), { recursive: true });
  writeFileSync(join(agent.agentDir, "AGENTS.md"), renderAgentMd(parsed, source));
  for (const slug of agent.skills) {
    const bucket = parsed.skillFiles[slug];
    if (!bucket) continue;
    for (const [rel, text] of Object.entries(bucket)) {
      const target = join(agent.agentDir, PERSONA_SKILLS_DIR, slug, rel);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, text, { mode: 0o644 });
    }
  }
  writeFileSync(join(agent.agentDir, ".template-import.json"), `${JSON.stringify(marker, null, 2)}\n`);
};

const removeCreated = (dirs: string[]): void => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: the transaction is what guarantees no half-imported room.
    }
  }
};

/**
 * Commit room + agents in one transaction.
 *
 * `RoomStore.createRoomWithAgents` is the natural API, but it cannot be used
 * from outside the class: it forwards each caller-supplied `agent.roomId`, and
 * the room id is minted by `createRoom` *inside* that same transaction — an
 * external caller has no way to know it. Verified against the real store: an
 * agent row carrying an unknown room id fails the FK check and rolls the whole
 * call back (that is exactly how I1's own rollback test passes). So we replay
 * the store's own `tx` shape over the public `createRoom`/`addAgent`, keeping
 * the same all-or-nothing guarantee. `room-store.ts` is I1's deliverable, so it
 * stays untouched.
 */
const commitRoom = (
  store: RoomStore,
  plan: PlannedImport,
  now: number,
): { room: ChatRoom; agents: RoomAgent[] } => {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const room = store.createRoom(plan.roomInput, now);
    const agents = plan.agents.map((agent) => store.addAgent({ ...agent.input, roomId: room.id }, now));
    store.db.exec("COMMIT");
    // Re-read: addAgent() flips coordinator_agent_id *after* createRoom() read
    // the row, so the in-hand `room` would still report null.
    const fresh = store.getRoom(room.id);
    return { room: fresh ?? room, agents };
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }
};

/**
 * Parse, materialise and commit. Failure at any point leaves nothing behind:
 * created directories are removed, and the room plus its agents commit in a
 * single transaction.
 */
export function importTemplatePackage(options: ImportOptions): ImportResult {
  const plan = planTemplateImport(options.zip, {
    projectId: options.projectId,
    roomsRoot: options.roomsRoot,
    parse: options.parse,
  });
  const now = options.now ?? Date.now();
  const marker = {
    templateId: plan.parsed.manifest.templateId,
    templateVersion: plan.parsed.manifest.version,
    templateTitle: plan.parsed.manifest.title,
    schemaVersion: plan.parsed.manifest.schemaVersion,
    roomName: plan.parsed.room.name,
    agentCount: plan.agents.length,
    agentDir: "",
    importedAt: now,
  };

  const created: string[] = [];
  if (!existsSync(plan.roomRoot)) {
    try {
      mkdirSync(plan.roomRoot, { recursive: true });
      created.push(plan.roomRoot);
    } catch (err) {
      throw new TemplateImportError("WRITE_FAILED", `无法创建 ${plan.roomRoot}：${msg(err)}`);
    }
  }
  try {
    for (const agent of plan.agents) {
      writeAgentDir(plan, agent, { ...marker, agentDir: agent.agentDir });
      created.push(agent.agentDir);
    }
  } catch (err) {
    removeCreated(created);
    if (err instanceof TemplateImportError) throw err;
    throw new TemplateImportError("WRITE_FAILED", `写入 agentDir 失败，已清理不留下半成品：${msg(err)}`);
  }

  let committed: { room: ChatRoom; agents: RoomAgent[] };
  try {
    committed = commitRoom(options.store, plan, now);
  } catch (err) {
    removeCreated(created);
    const message = err instanceof Error ? err.message : String(err);
    throw new TemplateImportError("WRITE_FAILED", `导入提交失败，agentDir 已清理，不留下半成品：${message}`);
  }

  const filesWritten = plan.agents.flatMap((agent) => agent.files.map((rel) => join(agent.agentDir, rel)));

  // AC4.3: convert the package's `cronTasks` into trigger rules.
  //
  // Done AFTER `commitRoom`, because a rule names a MEMBER ID and the ids only
  // exist once the agents are committed. The mapping is pure
  // (`planCronRules`); this is where it is bound to the roster that just landed.
  //
  // A refusal (a target the package does not contain, a non-cron schedule type, an
  // unparseable expression) is returned by name in `cronRefused` and never silently
  // dropped. Registration failures are refusals too, for the same reason.
  const cronPlan = planCronRules(plan.parsed.cronTasks, {
    workspacePath: options.workspacePath ?? resolve(process.cwd()),
    memberIdForTemplateAgent: (templateAgentId) => {
      const index = plan.agents.findIndex((a) => a.templateAgentId === templateAgentId);
      return index === -1 ? null : (committed.agents[index]?.id ?? null);
    },
    agentIdOf: (task) => {
      const ids = Array.isArray(task.agentIds) ? task.agentIds : [];
      return typeof ids[0] === "string" ? ids[0] : null;
    },
    lanePrefix: plan.parsed.manifest.roomRef,
  });
  const cronRules: TriggerRule[] = [];
  const cronRuleInputs: Array<Record<string, unknown>> = [];
  // `registered` vs `unregistered` is NOT `converted` vs `refused`. A seam that
  // returns null may be a store refusal OR a dry run (this very script's seam returns
  // null on purpose). Reporting a dry run as "refused" would tell an operator that a
  // working template had a broken schedule.
  let unregistered = 0;
  for (const input of cronPlan.rules) {
    cronRuleInputs.push(input as unknown as Record<string, unknown>);
    if (!options.registerCronRule) { unregistered += 1; continue; }
    const stored = options.registerCronRule(input as unknown as Record<string, unknown>);
    if (stored) cronRules.push(stored);
    else unregistered += 1;
  }
  // The report says what actually happened, not what was intended.
  if (cronPlan.rules.length > 0) {
    const idx = plan.ignoredFields.findIndex((f) => f.field === "cronTasks");
    const time = cronPlan.rules.length;
    const text = `已转为触发规则（AC4.3/P9.5）：${time} 个定时任务`
      + (options.registerCronRule
        ? `，${cronRules.length} 个已登记，${unregistered} 个未登记（seam 未返回规则）`
        : `，未登记（未提供注册 seam，转出的规则在 cronRuleInputs）`);
    if (idx !== -1) plan.ignoredFields[idx] = { ...plan.ignoredFields[idx]!, reason: text, value: `${time} 个定时任务 → 规则` };
    else plan.ignoredFields.push({ scope: "package", field: "cronTasks", reason: text, value: `${time} 个定时任务 → 规则` });
    for (const refusal of cronPlan.refused) {
      plan.warnings.push({ code: "cron-task-not-converted", message: `定时任务「${refusal.name}」未转成规则：${refusal.reason}` });
    }
  }

  const report = {
    ...marker,
    importId: `import-${randomUUID()}`,
    roomRoot: plan.roomRoot,
    room: committed.room,
    coordinator: plan.coordinator,
    agents: committed.agents.map((agent, i) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      isCoordinator: agent.isCoordinator,
      agentDir: agent.agentDir,
      thinkingMode: agent.thinkingMode,
      emoji: agent.emoji,
      color: agent.color,
      skills: plan.agents[i]?.skills ?? [],
    })),
    ignoredFields: plan.ignoredFields,
    warnings: plan.warnings,
    filesWritten,
  };
  const reportPath = join(plan.roomRoot, "import-report.json");
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    filesWritten.push(reportPath);
  } catch (err) {
    // The room is committed and usable; only the audit file is missing. Warn,
    // never pretend the import failed.
    plan.warnings.push({
      code: "report-write-failed",
      message: `import-report.json 写入失败（不影响导入结果）：${msg(err)}`,
    });
  }

  return {
    room: committed.room,
    agents: committed.agents,
    coordinator: plan.coordinator,
    roomRoot: plan.roomRoot,
    agentDirs: plan.agents.map((a) => a.agentDir),
    filesWritten,
    ignoredFields: plan.ignoredFields,
    warnings: plan.warnings,
    parsed: plan.parsed,
    cronRules,
    cronRuleInputs,
    cronRefused: cronPlan.refused,
  };
}
