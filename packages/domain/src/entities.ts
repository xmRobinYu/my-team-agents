/**
 * Domain skeleton — v1 entities, deliberately narrow, with seams left open.
 *
 * V1 scope: the collaboration spine (project / group / member / task / handoff).
 * Deliberately NOT in v1 (seams preserved, deferred by decision):
 *  - Capability packages & 藏经阁 as an installable-package repo (deferred; v1 = LLM wiki + RAG)
 *  - Promotion / HR review / grade lifecycle (deferred; v1 = daily self-assessment skill)
 *  - Full 5-layer cost attribution (deferred; v1 = daily report from session logs)
 */

export interface Tenant {
  id: string;
  name: string;
}

/**
 * Project OWNS the working directory. A group chat is only a collaboration VIEW
 * over a project — dissolving or rebuilding a group never touches the workspace,
 * sessions, or artifacts.
 */
export interface Project {
  id: string;
  tenantId: string;
  name: string;
  workspacePath: string;
  /** Seam: future per-tenant/project Pi config dir (skills, auth.json, AGENTS.md). */
  agentDir?: string;
}

/** Group chat: a view. Membership of execution agents is resolved through the project. */
export interface Group {
  id: string;
  projectId: string;
  name: string;
}

export type MemberKind = "human" | "agent";

/**
 * Agents are bound to exactly one project (their skills/memory live in its workspace).
 * Reporting roles (PMO / group manager / HR) may span projects — hence the optional
 * `projectId`. This two-tier split is per decision Q2/Q4.
 */
export interface Member {
  id: string;
  tenantId: string;
  kind: MemberKind;
  name: string;
  /** Null for cross-project roles such as PMO. */
  projectId: string | null;
  runtime: "pi" | "claude-cli" | "codex-cli" | "dsh-cli";
  /** Seam: future grade/level. Not used by any v1 logic. */
  grade?: string;
}

export type TaskStatus = "queued" | "running" | "settled" | "failed" | "aborted";

export interface Task {
  id: string;
  tenantId: string;
  projectId: string;
  memberId: string;
  groupId?: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
}

/** Structured handoff replaces prose/regex parsing: the agent declares intent. */
export interface Handoff {
  id: string;
  fromTaskId: string;
  fromMemberId: string;
  toMemberIds: string[];
  reason: string;
  depth: number;
  createdAt: string;
}
