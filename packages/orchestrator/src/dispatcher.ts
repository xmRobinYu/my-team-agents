/**
 * Dispatcher — the run loop that closes the skeleton.
 *
 * Pipeline: trigger -> queue -> executor -> structured handoff -> (re-queue).
 *
 * Two invariants carried over from teamagentx, both learned the hard way:
 *  1. Handoff dispatch happens AFTER the run settles, never mid-stream, so a
 *     run that is still emitting cannot fan out unbounded.
 *  2. Every dispatch is bounded by deterministic guardrails. No loop here
 *     depends on the model choosing to stop.
 */

import type { CanonicalEvent, RuntimeAdapter, RunSpec } from "@my-team-agents/runtime-core";
import { DEFAULT_GUARDRAILS, evaluateHandoff, type HandoffGuardrails } from "@my-team-agents/domain";
import { extractHandoffs, type HandoffIntent } from "./handoff-intent.js";

export interface DispatchRequest {
  tenantId: string;
  projectId: string;
  memberId: string;
  workspacePath: string;
  prompt: string;
  groupId?: string;
  model?: string;
  /** Depth of this run in the current handoff chain (0 for a human trigger). */
  depth?: number;
}

export interface ChainState {
  budgetUsed: number;
  visitCounts: Record<string, number>;
}

export interface DispatchOutcome {
  runId: string;
  status: "completed" | "aborted" | "failed";
  /** Handoffs that were accepted and queued. */
  dispatched: Array<{ toMemberIds: string[]; depth: number }>;
  /** Handoffs rejected by guardrails, with reasons. Never silent. */
  rejected: Array<{ toMemberIds: string[]; reason: string }>;
  issues: string[];
  events: CanonicalEvent[];
}

export interface DispatcherDeps {
  /** Resolve which adapter runs a given member. */
  adapterFor(memberId: string): RuntimeAdapter;
  /** Optional observer for streaming/UI; kept out of the decision path. */
  onEvent?: (event: CanonicalEvent) => void;
  guardrails?: HandoffGuardrails;
  /** Injectable for tests: default is sequential execution of queued runs. */
  runIdFactory?: () => string;
}

let counter = 0;
const defaultRunId = () => `run-${Date.now()}-${(counter += 1)}`;

/**
 * Run one task and dispatch whatever handoffs it declared.
 *
 * The queue is intentionally a local FIFO: v1 has no persistence, so a crash
 * loses queued work. That is a known v1 limit, not an oversight — persistence
 * is the natural next seam.
 */
export async function dispatch(
  req: DispatchRequest,
  deps: DispatcherDeps,
  chain: ChainState = { budgetUsed: 0, visitCounts: {} },
): Promise<DispatchOutcome> {
  const guardrails = deps.guardrails ?? DEFAULT_GUARDRAILS;
  const adapter = deps.adapterFor(req.memberId);
  const depth = req.depth ?? 0;
  const runId = (deps.runIdFactory ?? defaultRunId)();

  const spec: RunSpec = {
    runId,
    tenantId: req.tenantId,
    projectId: req.projectId,
    memberId: req.memberId,
    workspacePath: req.workspacePath,
    prompt: req.prompt,
    ...(req.model ? { model: req.model } : {}),
  };

  const events: CanonicalEvent[] = [];
  let settledStatus: DispatchOutcome["status"] = "completed";
  let error: string | undefined;
  let handle: Awaited<ReturnType<RuntimeAdapter["start"]>> | null = null;

  try {
    // start() is inside the try on purpose: a missing runtime binary throws
    // synchronously here (spawn ENOENT), and that must degrade to "failed",
    // not propagate and take the caller down.
    handle = await adapter.start(spec);
    for await (const event of handle.events) {
      events.push(event);
      deps.onEvent?.(event);
    }
    const result = await handle.settled;
    settledStatus = result.status;
    error = result.error;
  } catch (err) {
    settledStatus = "failed";
    error = err instanceof Error ? err.message : String(err);
  }

  // Handoffs only dispatch after settle — invariant #1.
  const { intents, issues } = extractHandoffs(events);
  const dispatched: DispatchOutcome["dispatched"] = [];
  const rejected: DispatchOutcome["rejected"] = [];

  if (settledStatus !== "completed") {
    for (const intent of intents) {
      rejected.push({ toMemberIds: intent.toMemberIds, reason: `run did not complete (${settledStatus})` });
    }
    return {
      runId,
      status: settledStatus,
      dispatched,
      rejected,
      issues: error ? [...issues, error] : issues,
      events,
    };
  }

  let budgetUsed = chain.budgetUsed;
  const visitCounts = { ...chain.visitCounts };

  for (const intent of intents) {
    const decision = evaluateHandoff(
      { depth, budgetUsed, visitCounts },
      intent.toMemberIds,
      guardrails,
    );
    if (!decision.allowed) {
      // Invariant #2: bounds are enforced here, independent of model behavior.
      rejected.push({ toMemberIds: intent.toMemberIds, reason: decision.reason ?? "rejected" });
      continue;
    }
    budgetUsed += intent.toMemberIds.length;
    for (const id of intent.toMemberIds) {
      visitCounts[id] = (visitCounts[id] ?? 0) + 1;
    }
    dispatched.push({ toMemberIds: intent.toMemberIds, depth: depth + 1 });
  }

  return {
    runId,
    status: settledStatus,
    dispatched,
    rejected,
    issues: error ? [...issues, error] : issues,
    events,
  };
}

export type { HandoffIntent };
