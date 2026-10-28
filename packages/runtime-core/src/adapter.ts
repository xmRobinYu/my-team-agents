/**
 * RuntimeAdapter — one contract for every agent runtime.
 *
 * V1: `runtime-pi` is the only full adapter (Pi is the core loop).
 * `claude` / `codex` / `dsh` are CLI adapters: spawn a child process and normalize
 * stdout into CanonicalEvent. They are intentionally minimal in v1 — no streaming
 * UI fidelity, no mid-run steering — and the capability block below exists so the
 * server never offers an action the runtime cannot perform.
 *
 * Extension seams for later phases (do not implement now, keep the shape stable):
 *  - `agentDirPerRun`: per-tenant/per-project Pi config dir (blocked upstream in
 *    @assistant-ui/react-pi — agentDir is supervisor-construction-only).
 *  - `approval`: codex exposes --ask-for-approval/--sandbox; Pi has no built-in
 *    approval system, so Pi's boundary must come from the process/container.
 */

import type { CanonicalEvent } from "./events.js";

export interface RuntimeCapabilities {
  streaming: boolean;
  /** Can inject a message mid-run (Pi: steer; claude: --input-format stream-json). */
  steer: boolean;
  cancel: boolean;
  /** Pi: none. codex: policy. claude: policy. */
  approval: "none" | "policy" | "interactive";
  /** codex: --sandbox. Pi: none (trust does NOT constrain tool access). */
  sandbox: "none" | "read-only" | "workspace-write" | "full";
  workspacePerRun: boolean;
  agentDirPerRun: boolean;
  /** Message-level usage is what makes per-member cost attribution possible. */
  usageAttribution: "message" | "session" | "none";
  costCap: boolean;
  /**
   * Can resume a previous run's session with its history (Pi: --session <path>).
   * Q18 requires resuming the original session when the runtime supports it;
   * when false, recovery falls back to a new Attempt built from the snapshot.
   */
  sessionResume: boolean;
}

export type RuntimeKind = "pi" | "claude-cli" | "codex-cli" | "dsh-cli";

export interface RunImage {
  data: string;
  mimeType: string;
}

export interface RunSession {
  sessionId: string;
  sessionDir: string;
  /** Full path to the session file (e.g. ~/.pi/agent/sessions/<ws>/<ts>_<id>.jsonl).
   *  Pi's --session <path> loads history; --session-id alone does not. */
  sessionPath?: string;
  resume: boolean;
}

export interface RunSpec {
  runId: string;
  /** Attribution keys for cost reporting. */
  tenantId: string;
  projectId: string;
  memberId: string;
  /** Project-owned working directory (project dir is decoupled from group membership). */
  workspacePath: string;
  /** Future: per-tenant/project Pi config dir. Ignored by v1 Pi adapter until upstream allows it. */
  agentDir?: string;
  model?: string;
  prompt: string;
  images?: RunImage[];
  session?: RunSession;
  /** Pi: --thinking. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface RunHandle {
  runId: string;
  events: AsyncIterable<CanonicalEvent>;
  cancel(signal?: "abort" | "clear-queue"): Promise<void>;
  /** Resolves when the runtime reports no remaining automatic work (Pi: agent_settled). */
  settled: Promise<RunResult>;
}

export interface RunResult {
  runId: string;
  status: "completed" | "aborted" | "failed";
  error?: string;
  /**
   * Pi session file backing this run. The durable store persists it so a later
   * Attempt resumes the same session with its history (Q18) instead of only
   * re-running from the deterministic recovery snapshot.
   */
  sessionFile?: string;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  start(spec: RunSpec): Promise<RunHandle>;
}
