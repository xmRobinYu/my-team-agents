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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { ChatRoom, RoomAgent } from "@my-team-agents/domain";
import type { CreateRoomAgentInput, CreateRoomInput, RoomStore } from "./room-store.js";

/** A package arrives either as a path on disk or as an already-uploaded buffer. */
export type ZipSource = string | Uint8Array;

export type TemplateErrorCode =
  | "ZIP_UNREADABLE"
  | "ZIP_INVALID"
  | "FILE_MISSING"
  | "JSON_INVALID"
  | "SCHEMA_MISMATCH"
  | "ROOM_INVALID"
  | "AGENTS_INVALID"
  | "AGENT_INVALID"
  | "WRITE_FAILED";

/** Every structural failure of a package surfaces as this, carrying a code. */
export class TemplateImportError extends Error {
  readonly code: TemplateErrorCode;
  readonly file?: string;

  constructor(code: TemplateErrorCode, message: string, file?: string) {
    super(`[${code}] ${message}`);
    this.name = "TemplateImportError";
    this.code = code;
    this.file = file;
  }
}

export interface IgnoredField {
  scope: "manifest" | "room" | "agent" | "package";
  field: string;
  /** Set when scope === "agent". */
  agentName?: string;
  /** Why it is not migrated — separates "out of scope by decision" from "lost by bug". */
  reason: string;
  /** Short rendering of the discarded value; proof that it was seen. */
  value?: string;
}

export interface ImportWarning {
  code: string;
  message: string;
  agentName?: string;
}

/** How the coordinator was decided. Priority order; see `resolveCoordinator`. */
export type CoordinatorSource = "room.defaultAgentId" | "heuristic" | "fallback-first-agent";

export interface CoordinatorDecision {
  /** Snapshot-side id (`agents[].id`), not the database id. */
  templateAgentId: string;
  agentName: string;
  source: CoordinatorSource;
  /** Rationale, surfaced in the API response and the on-disk report. */
  rationale: string;
  /** Agents that matched the heuristic, whether or not they were chosen. */
  candidates: string[];
}

export interface ParsedAgent {
  templateAgentId: string;
  name: string;
  /** Chinese role when room.rules declares one, e.g. 高见远 → 架构师. */
  role: string;
  prompt: string;
  frontmatter: Record<string, string>;
  emoji: string | null;
  color: string | null;
  thinkingMode: string | null;
  /** Declared model (claudeModel/codexModel); recorded as ignored, never applied. */
  declaredModel: string | null;
  capabilityTypes: string[];
  /** Slugs referenced by skill-usages whose files actually exist in the zip. */
  skillSlugs: string[];
}

export interface ParsedTemplate {
  manifest: {
    schemaVersion: string;
    templateId: string;
    version: string;
    title: string;
    /** `snapshot.room.id`: the stable package-side key for the directory tree. */
    roomRef: string;
    declared: { agents: number; skills: number; categories: number; cronTasks: number };
  };
  room: { name: string; description: string; rules: string };
  /** `snapshot.room.defaultAgentId` — the package's own coordinator designation. */
  defaultAgentRef: string | null;
  agents: ParsedAgent[];
  /** slug -> relative path -> file text. */
  skillFiles: Record<string, Record<string, string>>;
  ignoredFields: IgnoredField[];
  warnings: ImportWarning[];
}

export interface PlannedAgent {
  /** RoomStore insert input; `roomId` is filled in at commit time. */
  input: Omit<CreateRoomAgentInput, "roomId">;
  templateAgentId: string;
  agentDir: string;
  role: string;
  skills: string[];
  /** Paths this import writes inside `agentDir`, relative. */
  files: string[];
}

export interface PlannedImport {
  parsed: ParsedTemplate;
  coordinator: CoordinatorDecision;
  roomInput: CreateRoomInput;
  agents: PlannedAgent[];
  /** Directory holding this import: `<roomsRoot>/<roomRef>-<nonce>`. */
  roomRoot: string;
  ignoredFields: IgnoredField[];
  warnings: ImportWarning[];
}

export interface ImportResult {
  room: ChatRoom;
  agents: RoomAgent[];
  coordinator: CoordinatorDecision;
  roomRoot: string;
  agentDirs: string[];
  filesWritten: string[];
  ignoredFields: IgnoredField[];
  warnings: ImportWarning[];
  parsed: ParsedTemplate;
}

export interface ParseOptions {
  /** Hard-fail when manifest.contents.agents disagrees with snapshot.agents. */
  strictCounts?: boolean;
}

export interface ImportOptions {
  zip: ZipSource;
  store: RoomStore;
  /** Imported agents become members of this project (Q34). */
  projectId: string;
  /** Root for generated persona directories. Defaults to `<cwd>/.rooms`. */
  roomsRoot?: string;
  now?: number;
  parse?: ParseOptions;
}

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

// --- readers ---------------------------------------------------------------

const decoder = /* @__PURE__ */ new TextDecoder("utf-8");

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/** Compact rendering of a discarded value; empty/false-y noise returns undefined. */
const preview = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "false" || trimmed === "[]" || trimmed === "{}" || trimmed === "null") {
    return undefined;
  }
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

const unpack = (source: ZipSource): Record<string, Uint8Array> => {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    try {
      bytes = new Uint8Array(readFileSync(source));
    } catch (err) {
      throw new TemplateImportError("ZIP_UNREADABLE", `模板包无法读取：${source} — ${msg(err)}`, source);
    }
  } else {
    bytes = source;
  }
  if (bytes.length < 4) throw new TemplateImportError("ZIP_INVALID", "内容太短，不是 zip 包");
  try {
    return unzipSync(bytes);
  } catch (err) {
    throw new TemplateImportError("ZIP_INVALID", `不是可解析的 zip：${msg(err)}`);
  }
};

const entryText = (entries: Record<string, Uint8Array>, name: string): string | undefined => {
  const hit = entries[name];
  return hit === undefined ? undefined : decoder.decode(hit);
};

const readRequiredJson = (entries: Record<string, Uint8Array>, file: string): unknown => {
  const raw = entryText(entries, file);
  if (raw === undefined) throw new TemplateImportError("FILE_MISSING", `模板包缺少 ${file}`, file);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new TemplateImportError("JSON_INVALID", `${file} 不是合法 JSON：${msg(err)}`, file);
  }
};

/**
 * Optional side file. A missing or unparsable one is a warning, not a crash:
 * skills and capability descriptors enrich the import but a room without them
 * is still importable — I2 says "解析不了就记警告，不要崩".
 */
const readOptionalJsonArray = (
  entries: Record<string, Uint8Array>,
  file: string,
  warnings: ImportWarning[],
): unknown[] | undefined => {
  const raw = entryText(entries, file);
  if (raw === undefined) {
    warnings.push({ code: "file-missing", message: `包内没有 ${file}，相关信息按缺省处理` });
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      warnings.push({ code: "file-shape-unexpected", message: `${file} 顶层不是数组，已忽略` });
      return undefined;
    }
    return parsed;
  } catch (err) {
    warnings.push({ code: "file-invalid-json", message: `${file} 解析失败，已忽略：${msg(err)}` });
    return undefined;
  }
};

// --- frontmatter -----------------------------------------------------------

/**
 * Minimal YAML reader for persona frontmatter: top-level `key: scalar` only.
 * Nested maps (the IP package's `displayName: { zh, en }`) are skipped rather
 * than guessed — a wrong guess would corrupt the persona.
 */
export function parseFrontmatter(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = prompt.replace(/^\r?\n/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") break;
    if (/^\s/.test(line)) continue; // nested value belonging to the previous key
    const kv = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? "").trim();
    if (key && value) out[key] = value.replace(/^["'](.*)["']$/, "$1");
  }
  return out;
}

// --- coordinator -----------------------------------------------------------

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
const sanitizeSegment = (raw: string, prefix: string): string => {
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

  // Deliberately not migrated (Q31) — recorded, not swallowed.
  for (const field of ["categories", "cronTasks"] as const) {
    const value = snapshot[field];
    const n = Array.isArray(value) ? value.length : 0;
    const label = field === "categories" ? "分类" : "定时任务";
    ignored.push({
      scope: "package",
      field,
      reason: n > 0 ? `不迁移（Q31）：包内 ${n} 个${label}，本次导入丢弃` : "不迁移（Q31）",
      value: n > 0 ? `${n} 个${label}` : undefined,
    });
    if (n > 0) {
      warnings.push({ code: `${field}-not-migrated`, message: `包内有 ${n} 个${label}，按 Q31 不迁移` });
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
    ignoredFields: ignored,
    warnings,
  };
}

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
    const skillPaths = agent.skillSlugs.flatMap((slug) =>
      Object.keys(parsed.skillFiles[slug] ?? {}).map((rel) => `skills/${slug}/${rel}`),
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
  mkdirSync(join(agent.agentDir, "skills"), { recursive: true });
  writeFileSync(join(agent.agentDir, "AGENTS.md"), renderAgentMd(parsed, source));
  for (const slug of agent.skills) {
    const bucket = parsed.skillFiles[slug];
    if (!bucket) continue;
    for (const [rel, text] of Object.entries(bucket)) {
      const target = join(agent.agentDir, "skills", slug, rel);
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
  };
}
