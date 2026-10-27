/**
 * 前端领域模型 — 与 packages/orchestrator 的 SQLite 行形状保持一致。
 *
 * 该文件刻意不 import 后端包：工作台通过 HTTP/SSE 消费 JSON，
 * 避免把 Node 类型（node:sqlite 等）拖进浏览器 bundle。
 * Seam: 若后端抽出共享 DTO 包，可整体替换为本仓库类型。
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface TaskResult {
  outcome: "success" | "partial" | "failed";
  summary: string;
  artifacts: Array<{ path: string; description?: string }>;
  remainingRisks: string[];
}

export interface TaskRecord {
  id: string;
  chainId: string;
  parentTaskId?: string;
  tenantId: string;
  projectId: string;
  memberId: string;
  workspacePath: string;
  prompt: string;
  groupId?: string;
  model?: string;
  depth: number;
  batch: number;
  batchAttempts: number;
  fencingToken: number;
  idempotencyKey?: string;
  recoverySnapshot?: string;
  status: TaskStatus;
  activeAttemptId: string | null;
  availableAt: number;
  result: TaskResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AttemptRecord {
  id: string;
  taskId: string;
  sequence: number;
  batch: number;
  fencingToken: number;
  workerId: string;
  status: "leased" | "running" | "completed" | "failed" | "orphaned" | "cancelled";
  leaseExpiresAt: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** runtime-core CanonicalEvent 的浏览器端镜像。 */
export interface CanonicalEvent {
  type: string;
  rawType?: string;
  runId: string;
  timestamp: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  model?: string;
  provider?: string;
  isError?: boolean;
  error?: string;
}

export interface TaskEventRow {
  id: number;
  attemptId: string;
  sequence: number;
  event: CanonicalEvent;
}

export interface UsageRecord {
  attemptId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

/** outbox 行通过 getOutbox 以 Record<string, unknown> 返回，仅承诺这些键。 */
export interface HandoffRecord {
  id: string;
  source_tool_call_id: string;
  target_member_id: string;
  child_task_id: string;
  reason: string;
  status: string;
  created_at: number;
  [key: string]: unknown;
}

export interface ChainSummary {
  budgetUsed: number;
  visitCounts: Record<string, number>;
  cancelRequested: boolean;
}

export interface TaskDetail {
  task: TaskRecord;
  attempts: AttemptRecord[];
  events: TaskEventRow[];
  chain: ChainSummary;
  chainTasks: TaskRecord[];
  handoffs: HandoffRecord[];
  usage: UsageRecord[];
}

export interface CatalogTenant {
  id: string;
  name: string;
}

export interface CatalogProject {
  id: string;
  name: string;
  workspacePath: string;
}

export interface CatalogMember {
  id: string;
  name: string;
  runtime: string;
  projectId: string;
}

export interface Catalog {
  tenants: CatalogTenant[];
  projects: CatalogProject[];
  members: CatalogMember[];
  notice?: string;
}

export interface CreateTaskBody {
  tenantId: string;
  projectId: string;
  memberId: string;
  workspacePath: string;
  prompt: string;
  idempotencyKey: string;
}

export interface ConfirmBody {
  note: string;
  action: "retry" | "completed";
}
