/**
 * Session usage types.
 *
 * Field names mirror Pi's session JSONL (docs/session-format.md):
 * - assistant `message` entries carry `usage` plus `provider`/`model`
 * - standalone `usage` entries carry `usage` plus `kind` (e.g. `cache_warm`)
 */

export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type UsageRecordKind = "assistant" | "usage";

export interface UsageRecord {
  sessionPath: string;
  entryId: string;
  /** ISO 8601 from the session entry. */
  timestamp: string;
  kind: UsageRecordKind;
  /** Only present on standalone usage entries (e.g. `cache_warm`). Unknown values must be tolerated. */
  usageKind?: string;
  provider?: string;
  model?: string;
  usage: UsageBreakdown;
}

export interface Attribution {
  tenant: string;
  project: string;
  member: string;
}

export interface ParseIssue {
  sessionPath: string;
  line: number;
  message: string;
}

export interface ParseResult {
  records: UsageRecord[];
  issues: ParseIssue[];
}

export interface AggregateRow extends Attribution {
  model: string;
  provider: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
}

export const EMPTY_USAGE: UsageBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
