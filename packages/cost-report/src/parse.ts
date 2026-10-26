/**
 * Session log reader for Pi session JSONL files.
 *
 * Grounded in Pi docs (packages/coding-agent/docs/session-format.md):
 *  - assistant `message` entries carry `usage` plus `provider`/`model`
 *  - standalone `usage` entries (kind: e.g. `cache_warm`) also carry `usage`
 * A `since=<entryId>` cursor is persisted by callers so a daily run reads only
 * new entries; attribution therefore never depends on a promotion system.
 */

import { readFile } from "node:fs/promises";
import { EMPTY_USAGE } from "./types.js";
import type { ParseResult, UsageBreakdown, UsageRecord } from "./types.js";

type JsonRecord = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toUsage(v: unknown): UsageBreakdown {
  if (typeof v !== "object" || v === null) return EMPTY_USAGE;
  const u = v as JsonRecord;
  const rawCost = typeof u.cost === "object" && u.cost !== null ? (u.cost as JsonRecord) : {};
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    totalTokens: num(u.totalTokens),
    cost: {
      input: num(rawCost.input),
      output: num(rawCost.output),
      cacheRead: num(rawCost.cacheRead),
      cacheWrite: num(rawCost.cacheWrite),
      total: num(rawCost.total),
    },
  };
}

export interface ParseOptions {
  /** Only include entries after this entry id (exclusive). Absent = whole file. */
  since?: string;
}

export function parseSessionJsonl(content: string, sessionPath = "<memory>", options: ParseOptions = {}): ParseResult {
  const records: UsageRecord[] = [];
  const issues: ParseResult["issues"] = [];
  const lines = content.split("\n");
  let seenSince = !options.since;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (!line.trim()) return;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(line) as JsonRecord;
    } catch {
      issues.push({ sessionPath, line: lineNo, message: "invalid JSON" });
      return;
    }
    const id = typeof entry.id === "string" ? entry.id : `L${lineNo}`;
    if (!seenSince) {
      if (id === options.since) seenSince = true;
      return;
    }
    // Only entries that actually carry usage contribute to cost.
    if (typeof entry.usage !== "object" || entry.usage === null) return;

    const type = typeof entry.type === "string" ? entry.type : "";
    let kind: UsageRecord["kind"];
    if (type === "message") {
      const role = (typeof entry.message === "object" && entry.message !== null
        ? (entry.message as JsonRecord).role
        : undefined);
      if (role !== "assistant") return;
      kind = "assistant";
    } else if (type === "usage") {
      kind = "usage";
    } else {
      return;
    }

    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
    const usageKind = typeof entry.kind === "string" ? entry.kind : undefined;
    // Unknown usage kinds (e.g. a new Pi version) are kept, not dropped.
    records.push({
      sessionPath,
      entryId: id,
      timestamp: ts,
      kind,
      ...(usageKind !== undefined ? { usageKind } : {}),
      ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
      usage: toUsage(entry.usage),
    });
  });

  return { records, issues };
}

export async function parseSessionFile(path: string, options: ParseOptions = {}): Promise<ParseResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    return { records: [], issues: [{ sessionPath: path, line: 0, message: `unreadable: ${String(err)}` }] };
  }
  return parseSessionJsonl(content, path, options);
}
