/**
 * Daily self-assessment: attribute tokens/cost from Pi session logs.
 *
 * V1 scope is deliberately minimal — one daily pass, a report, and a persisted
 * cursor. The 5-layer attribution keys exist in the data model so later phases
 * can add a ledger without changing this shape.
 */

import type { AggregateRow, Attribution, UsageRecord } from "./types.js";

export function aggregate(records: UsageRecord[], attribution: Attribution): AggregateRow[] {
  const rows = new Map<string, AggregateRow>();
  for (const r of records) {
    const model = r.model ?? "unknown";
    const provider = r.provider ?? "unknown";
    const key = `${provider}|${model}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        ...attribution,
        model,
        provider,
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
      };
      rows.set(key, row);
    }
    row.calls += 1;
    row.input += r.usage.input;
    row.output += r.usage.output;
    row.cacheRead += r.usage.cacheRead;
    row.cacheWrite += r.usage.cacheWrite;
    row.totalTokens += r.usage.totalTokens;
    row.totalCost += r.usage.cost.total;
  }
  return [...rows.values()].sort((a, b) => b.totalCost - a.totalCost);
}

export function totals(rows: AggregateRow[]): {
  calls: number;
  totalTokens: number;
  totalCost: number;
} {
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      totalTokens: acc.totalTokens + r.totalTokens,
      totalCost: acc.totalCost + r.totalCost,
    }),
    { calls: 0, totalTokens: 0, totalCost: 0 },
  );
}

export function renderReport(rows: AggregateRow[]): string {
  const t = totals(rows);
  const lines: string[] = [];
  lines.push("# Daily self-assessment");
  lines.push("");
  lines.push(`calls: ${t.calls}`);
  lines.push(`totalTokens: ${t.totalTokens}`);
  lines.push(`totalCost: ${t.totalCost.toFixed(6)}`);
  lines.push("");
  if (rows.length > 0) {
    lines.push("| provider | model | calls | input | output | cacheRead | cacheWrite | totalTokens | cost |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      lines.push(
        `| ${r.provider} | ${r.model} | ${r.calls} | ${r.input} | ${r.output} | ${r.cacheRead} | ${r.cacheWrite} | ${r.totalTokens} | ${r.totalCost.toFixed(6)} |`,
      );
    }
  } else {
    lines.push("_no usage records_");
  }
  return `${lines.join("\n")}\n`;
}

/** Cursor persistence: `since` is an entry id, stable across restarts. */
export function nextCursor(records: UsageRecord[], previous?: string): string | undefined {
  const last = records[records.length - 1];
  return last ? last.entryId : previous;
}
