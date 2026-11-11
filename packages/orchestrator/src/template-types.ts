/**
 * Shapes shared by template parsing and import.
 *
 * Extracted from `template-import.ts` (which had grown past the repo's declared
 * 800-line limit). Pure declarations, no logic: the split is by phase, and every
 * module that needs to name a parsed/incoming shape imports it from here rather
 * than from the parser, so the dependency graph stays acyclic.
 */

import type { ChatRoom, RoomAgent } from "@my-team-agents/domain";
import type { readCronTasks } from "./ingest-import.js";
import type { TriggerRule } from "./ingest.js";
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
  /** AC4.3: raw `cronTasks[]`, carried out of the snapshot for rule conversion. */
  cronTasks: ReturnType<typeof readCronTasks>;
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
  /**
   * AC4.3: template `cronTasks` that became rules. Empty when the package declares
   * none OR when the caller supplied no `registerCronRule` seam — in which case the
   * converted inputs are still listed in `cronRuleInputs` so nothing is lost.
   */
  cronRules: TriggerRule[];
  /** Converted-but-unregistered rule inputs (no seam supplied). */
  cronRuleInputs: Array<Record<string, unknown>>;
  /** Schedules that could NOT be converted, with the reason. Never silent. */
  cronRefused: Array<{ name: string; reason: string }>;
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
  /**
   * AC4.3 seam: register one converted schedule as a rule. Injected so this module
   * keeps talking only to a `RoomStore`; a caller without an `IngestStore` still
   * gets the conversion reported (`cronRuleInputs`) instead of losing it. Returns
   * the stored rule, or null when the store refused it (reported as a refusal).
   */
  registerCronRule?: (input: Record<string, unknown>) => TriggerRule | null;
  /** Project workspace scheduled Tasks run against. Defaults to `<cwd>`. */
  workspacePath?: string;
}
