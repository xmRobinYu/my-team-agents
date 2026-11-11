/**
 * Reading a run back: the event stream -> a validated `TaskResult`.
 *
 * Split out of `durable-worker.ts` under the repo's declared 800-line limit
 * (`constraints.yaml`, enforced by `just verify-file-size`). Pure functions with no
 * store, clock or adapter, so the parsing rules can be tested without spawning a
 * runtime — and they are, in `durable-worker`'s own suite.
 *
 * `parseResult` accepts a bare JSON object OR one fenced in a markdown block, and
 * returns null rather than a half-valid result: a reply that does not carry
 * `outcome`/`summary`/`artifacts`/`remainingRisks` is `result_invalid`, not a guess
 * at what the agent meant.
 */

import type { CanonicalEvent } from "@my-team-agents/runtime-core";
import type { TaskResult } from "./execution-store.js";

export const hasStructuredResult = (value: unknown): value is TaskResult => {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<TaskResult>;
  return ["success", "partial", "failed"].includes(result.outcome ?? "")
    && typeof result.summary === "string" && result.summary.trim().length > 0
    && Array.isArray(result.artifacts) && Array.isArray(result.remainingRisks)
    && result.artifacts.every((a) => typeof a === "object" && a !== null
      && typeof (a as { path?: unknown }).path === "string")
    && result.remainingRisks.every((r) => typeof r === "string");
};

export const unknownHighRiskTools = (events: CanonicalEvent[]): string[] => {
  const safeTools = new Set(["read", "grep", "glob", "find", "ls", "handoff_to", "submit_result"]);
  const pending = new Map<string, string>();
  for (const event of events) {
    if (!event.toolCallId || !event.toolName || safeTools.has(event.toolName)) continue;
    if (event.type === "tool_execution_start") pending.set(event.toolCallId, event.toolName);
    if (event.type === "tool_execution_end") pending.delete(event.toolCallId);
  }
  return [...new Set(pending.values())];
};

export const latestText = (events: CanonicalEvent[]): string =>
  [...events].reverse().find((e) => e.type === "message_end" && e.text)?.text ?? "";

export const parseResult = (text: string): TaskResult | null => {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) candidates.push(match[1]?.trim() ?? "");
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (hasStructuredResult(value)) return value;
    } catch { /* Final prose is not a structured task result. */ }
  }
  return null;
};
