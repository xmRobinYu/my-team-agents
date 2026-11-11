/**
 * Phase 1 of template import: zip bytes -> a validated `ParsedTemplate` (pure).
 *
 * No filesystem writes, no database, no clock. That purity is the contract the PRD
 * relies on: a caller can parse and inspect a package before anything is committed.
 *
 * This file also holds the two policies that decide what a package MEANS:
 *   - `resolveCoordinator` — which agent runs the room, and why (never guessed
 *     silently; every decision carries its rationale and candidate list).
 *   - the field tables — anything present in the package but not migrated lands in
 *     `ignoredFields` with a reason, so an import can be audited afterwards.
 */

import { createHash } from "node:crypto";
import { TemplateImportError } from "./template-types.js";
import type {
  ZipSource,
  IgnoredField,
  ImportWarning,
  CoordinatorDecision,
  ParsedAgent,
  ParsedTemplate,
  ParseOptions,
} from "./template-types.js";
import { readCronTasks } from "./ingest-import.js";
import { asRecord, decoder, str, preview, unpack, readRequiredJson, readOptionalJsonArray } from "./template-readers.js";
import { SKILL_SLUG_PATTERN, judgeSkillFiles, readSkillFrontmatter } from "@my-team-agents/runtime-core";

const REQUIRED_FILES = ["manifest.json", "snapshot.json"] as const;
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0", "1"]);
/** Fields read and acted on per agent; anything else present gets reported. */
const MIGRATED_AGENT_FIELDS = new Set(["id", "name", "prompt", "thinkingMode"]);
const MIGRATED_ROOM_FIELDS = new Set(["name", "description", "rules", "defaultAgentId"]);

const AGENT_FIELD_REASONS: Record<string, string> = {
  acpTool: "ACP 直连工具（codex/claude）不属于 Pi 执行路径，不迁移",
  proxyConfig: "代理配置属于上游 runtime，不在 ChatRoom 领域模型内",
  codexModel: "模型绑定属于 runtime 配置，不在 ChatRoom 领域模型内",
  codexFastMode: "codex 快速模式属于 runtime 配置",
  claudeModel: "模型绑定属于 runtime 配置，不在 ChatRoom 领域模型内",
  llmProviderId: "provider 绑定属于 runtime 配置",
  speechConfig: "语音播报配置属于上游 UI，不在 ChatRoom 领域模型内",
  workDir: "上游 workDir 为空；cwd 由本次导入生成的 agentDir 承担",
  categoryId: "categories 不迁移（Q31）",
  type: "builtin/acp 区分上游 runtime 路由，Pi 路径不使用",
  capabilities: "image 等多模态能力不在 V1 群聊文本路径",
};

const ROOM_FIELD_REASONS: Record<string, string> = {
  id: "ChatRoom 主键由 RoomStore 生成；包内 id 仅用作 agentDir 目录键",
  workDir: "群工作区由 Project 决定（Q34），不采用上游绝对路径",
  agentTriggerMode: "触发模式已由 Q34 定为 auto，不被包覆盖",
};

/**
 * Minimal YAML reader for persona frontmatter: top-level `key: scalar` only.
 * Nested maps (the IP package's `displayName: { zh, en }`) are skipped rather
 * than guessed — a wrong guess would corrupt the persona.
 *
 * I9: the implementation moved to `@my-team-agents/runtime-core` because the
 * skill inspector needs the same rule, and two readers that drift would make the
 * importer and the listing disagree about a skill's own frontmatter. This keeps
 * the exported name stable for persona callers.
 */
export function parseFrontmatter(prompt: string): Record<string, string> {
  return readSkillFrontmatter(prompt);
}

const LEAD_ROLE_VALUES = new Set(["system", "lead", "coordinator", "orchestrator", "director", "main", "host"]);
const LEAD_FLAG_KEYS = ["system", "isLead", "isCoordinator", "lead", "coordinator", "orchestrator"];
const LEAD_TEXT = /(交付总监|总控|主理人|团队负责人|团队统筹|Delivery Director|Team Lead|Coordinator|Orchestrator)/i;

/** Heuristic markers that mean "this agent runs the room". */
const coordinatorHits = (agent: ParsedAgent): string[] => {
  const hits: string[] = [];
  for (const key of ["role", "kind", "type"] as const) {
    const value = agent.frontmatter[key];
    if (value && LEAD_ROLE_VALUES.has(value.toLowerCase())) hits.push(`frontmatter.${key}=${value}`);
  }
  for (const key of LEAD_FLAG_KEYS) {
    const value = agent.frontmatter[key];
    if (value && /^(true|yes|1)$/i.test(value)) hits.push(`frontmatter.${key}=${value}`);
  }
  const declared = agent.frontmatter["name"];
  if (declared && /lead|director|coordinator|orchestrator/i.test(declared)) hits.push(`frontmatter.name=${declared}`);
  if (LEAD_TEXT.test(agent.name)) hits.push(`name=${agent.name}`);
  if (agent.role && LEAD_TEXT.test(agent.role)) hits.push(`role=${agent.role}`);
  const head = agent.prompt.slice(0, 600);
  if (/(主理人|分派给合适的团队成员)/.test(head)) hits.push("prompt 头部含编排语义");
  return hits;
};

/**
 * Coordinator resolution, in strict priority order. Every branch reports
 * itself; nothing is assumed silently.
 *
 *  1. `room.defaultAgentId` — what teamagentx itself writes. Verified across
 *     all 34 sample packages: always present and always resolvable inside
 *     `agents[]`. Authoritative (Q30: "designated inside the template package").
 *  2. Heuristic markers on exactly **one** agent (frontmatter role/flag,
 *     交付总监/主理人 in name/role/prompt head). Used only when 1 is missing or
 *     dangling; if it contradicts 1 we keep 1 and warn instead of overriding.
 *  3. Fallback: **the first agent in snapshot order**, plus an explicit
 *     `coordinator-undetermined` warning naming the decision point. The round
 *     cap wrap-up and `[讨论结束]` termination both hang on this agent (Q30),
 *     so a wrong guess is a real behavioural bug — hence a loud warning rather
 *     than a quiet default.
 */
export function resolveCoordinator(parsed: ParsedTemplate): CoordinatorDecision {
  const agents = parsed.agents;
  const first = agents[0];
  if (!first) throw new TemplateImportError("AGENTS_INVALID", "包内没有任何 agent，无法确定协调者");

  const scored = agents.map((agent) => ({ agent, hits: coordinatorHits(agent) }));
  const candidates = scored.filter((s) => s.hits.length > 0).map((s) => s.agent.name);
  const ref = parsed.defaultAgentRef;

  if (ref) {
    const chosen = agents.find((a) => a.templateAgentId === ref);
    if (chosen) {
      const rival = scored.find((s) => s.hits.length > 0 && s.agent.templateAgentId !== chosen.templateAgentId);
      if (rival) {
        parsed.warnings.push({
          code: "coordinator-heuristic-conflict",
          message:
            `room.defaultAgentId 指定「${chosen.name}」，但启发式在「${rival.agent.name}」上读到标记`
            + `（${rival.hits.join(", ")}）；以包内指定为准`,
          agentName: rival.agent.name,
        });
      }
      return {
        templateAgentId: chosen.templateAgentId,
        agentName: chosen.name,
        source: "room.defaultAgentId",
        rationale: `snapshot.room.defaultAgentId=${ref} → 「${chosen.name}」（包内显式指定，Q30）`,
        candidates,
      };
    }
    parsed.warnings.push({
      code: "coordinator-default-unresolvable",
      message: `room.defaultAgentId=${ref} 在 agents[] 中找不到，降级为启发式识别`,
    });
  }

  const sole = scored.find((s) => s.hits.length > 0);
  if (sole && candidates.length === 1) {
    return {
      templateAgentId: sole.agent.templateAgentId,
      agentName: sole.agent.name,
      source: "heuristic",
      rationale: `包内无可用 defaultAgentId；唯一命中启发式的「${sole.agent.name}」（${sole.hits.join(", ")}）`,
      candidates,
    };
  }

  const reason = scored.length === 0
    ? "没有任何 agent 带协调者标记"
    : `${scored.length} 个 agent 同时带协调者标记（${candidates.join("、")}），无法唯一判定`;
  parsed.warnings.push({
    code: "coordinator-undetermined",
    message:
      `${reason}。决策点：snapshot.room.defaultAgentId ${ref ? `=${ref}（无法解析）` : "缺失"}；`
      + `已回退为「第一个 agent」=「${first.name}」（snapshot 顺序），需人工确认——`
      + "轮次超限强制收尾与 [讨论结束] 终止都挂在该 agent 上（Q30）。",
    agentName: first.name,
  });
  return {
    templateAgentId: first.templateAgentId,
    agentName: first.name,
    source: "fallback-first-agent",
    rationale: `${reason}；回退取 agents[0]=「${first.name}」，不是包内显式指定`,
    candidates,
  };
}

// --- parsing ---------------------------------------------------------------

/** room.rules carries the roster: `👑 齐活林（交付总监）` / `• 许清楚（产品经理）`. */
const roleFromRules = (rules: string, name: string): string => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = new RegExp(`${esc}\\s*[（(]([^）)]{1,24})[）)]`).exec(rules);
  return hit?.[1]?.trim() ?? "";
};

/** Keep hostile or non-ASCII ids out of the filesystem path, deterministically. */
export const sanitizeSegment = (raw: string, prefix: string): string => {
  const clean = raw.trim();
  if (!clean.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(clean)) return clean;
  const hash = createHash("sha1").update(clean).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
};

const ignoredAgentFields = (raw: Record<string, unknown>, name: string): IgnoredField[] => {
  const out: IgnoredField[] = [];
  for (const [field, value] of Object.entries(raw)) {
    if (MIGRATED_AGENT_FIELDS.has(field)) continue;
    const shown = preview(value);
    const reason = AGENT_FIELD_REASONS[field];
    if (shown === undefined && reason === undefined) continue;
    out.push({
      scope: "agent",
      field,
      agentName: name,
      reason: reason ?? "模板包字段，ChatRoom 领域模型没有对应概念",
      value: shown,
    });
  }
  return out;
};

export function parseTemplatePackage(source: ZipSource, options: ParseOptions = {}): ParsedTemplate {
  const entries = unpack(source);
  for (const file of REQUIRED_FILES) {
    if (entries[file] === undefined) {
      throw new TemplateImportError("FILE_MISSING", `模板包缺少 ${file}`, file);
    }
  }

  const manifest = asRecord(readRequiredJson(entries, "manifest.json"));
  if (!manifest) throw new TemplateImportError("SCHEMA_MISMATCH", "manifest.json 顶层不是对象", "manifest.json");
  const snapshot = asRecord(readRequiredJson(entries, "snapshot.json"));
  if (!snapshot) throw new TemplateImportError("SCHEMA_MISMATCH", "snapshot.json 顶层不是对象", "snapshot.json");

  const schemaVersion = str(manifest["schemaVersion"]) ?? "";
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new TemplateImportError(
      "SCHEMA_MISMATCH",
      `manifest.schemaVersion="${schemaVersion || "(缺失)"}"，本导入器支持 ${[...SUPPORTED_SCHEMA_VERSIONS].join("/")}`,
      "manifest.json",
    );
  }

  const roomRaw = asRecord(snapshot["room"]);
  if (!roomRaw) throw new TemplateImportError("ROOM_INVALID", "snapshot.json 缺少 room 对象", "snapshot.json");
  const roomName = str(roomRaw["name"])?.trim();
  if (!roomName) throw new TemplateImportError("ROOM_INVALID", "room.name 缺失，无法创建 ChatRoom", "snapshot.json");

  const agentList = snapshot["agents"];
  if (!Array.isArray(agentList)) {
    throw new TemplateImportError("AGENTS_INVALID", "snapshot.json 缺少 agents[] 数组", "snapshot.json");
  }
  if (agentList.length === 0) {
    throw new TemplateImportError("AGENTS_INVALID", "snapshot.agents 是空数组，无法建群", "snapshot.json");
  }

  const warnings: ImportWarning[] = [];
  const ignored: IgnoredField[] = [];

  const contents = asRecord(manifest["contents"]) ?? {};
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const declared = {
    agents: count(contents["agents"]),
    skills: count(contents["skills"]),
    categories: count(contents["categories"]),
    cronTasks: count(contents["cronTasks"]),
  };

  for (const field of ["summary", "source"] as const) {
    const shown = preview(manifest[field]);
    if (shown === undefined) continue;
    ignored.push({
      scope: "manifest",
      field,
      reason: "包摘要/来源不属于 ChatRoom 领域模型（title 只用于校验群名）",
      value: shown,
    });
  }

  if (declared.agents > 0 && declared.agents !== agentList.length) {
    const message = `manifest.contents.agents=${declared.agents} 与 snapshot.agents.length=${agentList.length} 不一致`;
    if (options.strictCounts) throw new TemplateImportError("SCHEMA_MISMATCH", message, "manifest.json");
    warnings.push({ code: "declared-count-mismatch", message });
  }

  const rules = str(roomRaw["rules"]) ?? "";
  for (const [field, value] of Object.entries(roomRaw)) {
    if (MIGRATED_ROOM_FIELDS.has(field)) continue;
    const shown = preview(value);
    if (shown === undefined && ROOM_FIELD_REASONS[field] === undefined) continue;
    ignored.push({
      scope: "room",
      field,
      reason: ROOM_FIELD_REASONS[field] ?? "room 字段，ChatRoom 领域模型没有对应概念",
      value: shown,
    });
  }

  const title = str(manifest["title"]) ?? "";
  if (title && title !== roomName) {
    warnings.push({
      code: "title-room-mismatch",
      message: `manifest.title=「${title}」与 room.name=「${roomName}」不同，按 room.name 建群`,
    });
  }
  if (rules.trim() === "") {
    warnings.push({ code: "room-rules-empty", message: "room.rules 为空，群内没有协作规则可注入" });
  }

  // skills/<slug>/<relpath>
  const skillFiles: Record<string, Record<string, string>> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    const hit = /^skills\/([^/]+)\/(.+)$/.exec(name);
    if (!hit) continue;
    const slug = hit[1] ?? "";
    const rel = hit[2] ?? "";
    if (!slug || !rel) continue;
    // I9: a package is untrusted input, and these strings become path segments
    // below in `writeAgentDir`. Enforce the slug whitelist and refuse `..`
    // segments here — the zip-slip equivalent of the traversal gate the skill
    // API applies to installs. Rejected entries are named, never quietly dropped.
    if (!SKILL_SLUG_PATTERN.test(slug)) {
      warnings.push({
        code: "skill-slug-invalid",
        message: `包内技能目录名「${slug}」不合 slug 规范（^[a-z0-9][a-z0-9-]{0,63}$），未落地：Pi 也不会承认这种名字`,
      });
      continue;
    }
    if (rel.split("/").some((segment) => segment === ".." || segment === "")) {
      warnings.push({
        code: "skill-path-escaped",
        message: `技能「${slug}」的文件「${rel}」含越界路径片段，未落地`,
      });
      continue;
    }
    const bucket = skillFiles[slug] ?? (skillFiles[slug] = {});
    bucket[rel] = decoder.decode(bytes);
  }

  // skill-usages: agentId -> slug
  const usages = new Map<string, string[]>();
  for (const item of readOptionalJsonArray(entries, "skill-usages.json", warnings) ?? []) {
    const u = asRecord(item);
    const agentId = u ? str(u["agentId"]) : null;
    const slug = u ? str(u["slug"]) : null;
    if (!agentId || !slug) continue;
    const list = usages.get(agentId) ?? [];
    if (!list.includes(slug)) list.push(slug);
    usages.set(agentId, list);
  }

  // capability-descriptors: agentRef -> capabilityType / tool
  const capTypes = new Map<string, string[]>();
  const capTools = new Map<string, string[]>();
  for (const item of readOptionalJsonArray(entries, "capability-descriptors.json", warnings) ?? []) {
    const c = asRecord(item);
    const ref = c ? str(c["agentRef"]) : null;
    if (!ref) continue;
    const type = (c ? str(c["capabilityType"]) : null) ?? "text";
    const types = capTypes.get(ref) ?? [];
    if (!types.includes(type)) types.push(type);
    capTypes.set(ref, types);
    const tool = c ? str(c["tool"]) : null;
    if (tool) {
      const tools = capTools.get(ref) ?? [];
      if (!tools.includes(tool)) tools.push(tool);
      capTools.set(ref, tools);
    }
  }

  const degraded = readOptionalJsonArray(entries, "degraded-skills.json", warnings);
  if (degraded && degraded.length > 0) {
    warnings.push({
      code: "degraded-skills",
      message: `上游导出时 ${degraded.length} 个技能被降级：${preview(degraded) ?? ""}`,
    });
  }

  const agents: ParsedAgent[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (let i = 0; i < agentList.length; i += 1) {
    const raw = asRecord(agentList[i]);
    if (!raw) throw new TemplateImportError("AGENT_INVALID", `agents[${i}] 不是对象`, "snapshot.json");
    const name = str(raw["name"])?.trim();
    if (!name) throw new TemplateImportError("AGENT_INVALID", `agents[${i}] 缺少 name`, "snapshot.json");
    const prompt = str(raw["prompt"]);
    if (prompt === null) {
      throw new TemplateImportError("AGENT_INVALID", `agents[${i}]「${name}」缺少 prompt`, "snapshot.json");
    }
    const id = str(raw["id"]) ?? `agent-${i}`;
    if (seenIds.has(id)) {
      throw new TemplateImportError("AGENT_INVALID", `agents[${i}] 的 id 重复：${id}`, "snapshot.json");
    }
    if (seenNames.has(name)) {
      throw new TemplateImportError(
        "AGENT_INVALID",
        `agents[${i}] 的 name 重复：${name}（@提及解析与目录命名都要求群内唯一）`,
        "snapshot.json",
      );
    }
    seenIds.add(id);
    seenNames.add(name);

    const frontmatter = parseFrontmatter(prompt);
    if (prompt.trim() === "") {
      warnings.push({
        code: "agent-prompt-empty",
        message: "prompt 为空，人格无内容可注入（上游 ACP 直连型 agent 常见）",
        agentName: name,
      });
    } else if (Object.keys(frontmatter).length === 0) {
      warnings.push({
        code: "agent-frontmatter-missing",
        message: "prompt 无 YAML frontmatter，emoji/color 取空",
        agentName: name,
      });
    }

    ignored.push(...ignoredAgentFields(raw, name));

    const types = capTypes.get(id) ?? [];
    for (const type of types) {
      if (type === "text") continue;
      ignored.push({
        scope: "agent",
        field: "capability-descriptors.capabilityType",
        agentName: name,
        reason: `${type} 能力不在 V1 群聊文本路径`,
      });
    }
    const tool = capTools.get(id);
    if (tool) {
      ignored.push({
        scope: "agent",
        field: "capability-descriptors.tool",
        agentName: name,
        reason: "上游工具白名单，不由模板导入授予",
        value: preview(tool),
      });
    }

    const slugs = usages.get(id) ?? [];
    const present: string[] = [];
    for (const slug of slugs) {
      if (skillFiles[slug]) present.push(slug);
      else {
        warnings.push({
          code: "skill-files-missing",
          message: `skill-usages 引用「${slug}」，但包内没有 skills/${slug}/ 文件，技能未落地`,
          agentName: name,
        });
      }
    }

    agents.push({
      templateAgentId: id,
      name,
      role: roleFromRules(rules, name),
      prompt,
      frontmatter,
      emoji: frontmatter["emoji"] ?? null,
      color: frontmatter["color"] ?? null,
      thinkingMode: str(raw["thinkingMode"]),
      declaredModel: str(raw["claudeModel"]) ?? str(raw["codexModel"]),
      capabilityTypes: types,
      skillSlugs: present,
    });
  }

  if (declared.skills > 0 && Object.keys(skillFiles).length === 0) {
    warnings.push({
      code: "skills-declared-absent",
      message: `manifest.contents.skills=${declared.skills}，但包内没有 skills/ 目录`,
    });
  }
  const referenced = new Set(agents.flatMap((a) => a.skillSlugs));
  for (const slug of Object.keys(skillFiles)) {
    if (referenced.has(slug)) continue;
    warnings.push({
      code: "skill-unattributed",
      message: `包内有 skills/${slug}/，但 skill-usages 没有把它分配给任何 agent，未落地`,
    });
  }

  // I9 / the "看得见但不会生效" case, reported at parse time: a skill whose
  // SKILL.md lacks a `description` (or has no SKILL.md at all) is skipped by Pi —
  // measured against the installed binary, not just inferred from docs. Landing it
  // silently would ship a persona that looks equipped and is not, so each one is
  // named here, per agent. Same `judgeSkillFiles` the listing endpoint uses, so the
  // import report and a later GET can never disagree. The skill is still landed:
  // AC8.1 exists so the user can see it and fix it.
  for (const agent of agents) {
    for (const slug of agent.skillSlugs) {
      const bucket = skillFiles[slug];
      if (!bucket) continue; // `skill-files-missing` already covers that case
      const judgement = judgeSkillFiles(slug, bucket);
      if (judgement.loadable) continue;
      warnings.push({
        code: `skill-not-loadable-${judgement.verdict}`,
        message: judgement.verdict === "missing-description"
          ? `技能「${slug}」缺 frontmatter description：会落盘，但按 Pi 规则不会被加载（看得见，不生效）`
          : judgement.verdict === "no-frontmatter"
            ? `技能「${slug}」的 SKILL.md 没有 frontmatter：会落盘，但 Pi 不会加载它`
            : `技能「${slug}」的目录内没有 SKILL.md：会落盘，但 Pi 不会加载它`,
        agentName: agent.name,
      });
    }
  }

  // `categories` is still deliberately not migrated (Q31) — recorded, not swallowed.
  {
    const value = snapshot["categories"];
    const n = Array.isArray(value) ? value.length : 0;
    ignored.push({
      scope: "package",
      field: "categories",
      reason: n > 0 ? `不迁移（Q31）：包内 ${n} 个分类，本次导入丢弃` : "不迁移（Q31）",
      value: n > 0 ? `${n} 个分类` : undefined,
    });
    if (n > 0) {
      warnings.push({ code: "categories-not-migrated", message: `包内有 ${n} 个分类，按 Q31 不迁移` });
    }
  }
  // AC4.3 REVERSES Q31 for `cronTasks`: a declared schedule is now CONVERTED to a
  // trigger rule (see `planCronRules`) instead of being dropped. The record below
  // stays — the field is still worth naming in the report — but it now says what
  // happened rather than "discarded". A task that cannot be converted is refused by
  // name in `cronRefused`, so the "never silent" property survives the change.
  {
    const cronTaskCount = readCronTasks(snapshot).length;
    const n = cronTaskCount;
    if (n === 0) {
      ignored.push({ scope: "package", field: "cronTasks", reason: "包内无定时任务" });
    } else {
      ignored.push({
        scope: "package",
        field: "cronTasks",
        reason: `已转为触发规则（AC4.3/P9.5）：包内 ${n} 个定时任务不再丢弃`,
        value: `${n} 个定时任务 → 待转换规则`,
      });
    }
  }

  return {
    manifest: {
      schemaVersion,
      templateId: str(manifest["templateId"]) ?? "",
      version: str(manifest["version"]) ?? "",
      title: title || roomName,
      roomRef: sanitizeSegment(str(roomRaw["id"]) ?? str(manifest["templateId"]) ?? "template", "room"),
      declared,
    },
    room: { name: roomName, description: str(roomRaw["description"]) ?? "", rules },
    defaultAgentRef: str(roomRaw["defaultAgentId"]),
    agents,
    skillFiles,
    cronTasks: readCronTasks(snapshot),
    ignoredFields: ignored,
    warnings,
  };
}

