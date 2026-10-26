/**
 * Handoff guardrails — deterministic limits applied AFTER the runtime settles.
 *
 * Modeled on teamagentx's structured-handoff design: the agent records intent
 * (mention-style) during the run, and dispatch happens here, bounded by numbers
 * that never depend on the model behaving well.
 */

export interface HandoffGuardrails {
  fanoutMax: number;
  depthMax: number;
  budgetMax: number;
  /** Re-visit limit per member; prevents two agents ping-ponging forever. */
  revisitMax: number;
}

export const DEFAULT_GUARDRAILS: HandoffGuardrails = {
  fanoutMax: 20,
  depthMax: 100,
  budgetMax: 20,
  revisitMax: 5,
};

export interface HandoffDecision {
  allowed: boolean;
  reason?: string;
}

export interface HandoffContext {
  depth: number;
  budgetUsed: number;
  /** How many times each candidate member has already been visited in this chain. */
  visitCounts: Record<string, number>;
}

export function evaluateHandoff(
  ctx: HandoffContext,
  targets: string[],
  guardrails: HandoffGuardrails = DEFAULT_GUARDRAILS,
): HandoffDecision {
  if (targets.length === 0) return { allowed: false, reason: "no targets" };
  if (targets.length > guardrails.fanoutMax) {
    return { allowed: false, reason: `fanout ${targets.length} > ${guardrails.fanoutMax}` };
  }
  if (ctx.depth >= guardrails.depthMax) {
    return { allowed: false, reason: `depth ${ctx.depth} >= ${guardrails.depthMax}` };
  }
  if (ctx.budgetUsed >= guardrails.budgetMax) {
    return { allowed: false, reason: `budget ${ctx.budgetUsed} >= ${guardrails.budgetMax}` };
  }
  const overRevisit = targets.filter((t) => (ctx.visitCounts[t] ?? 0) >= guardrails.revisitMax);
  if (overRevisit.length > 0) {
    return { allowed: false, reason: `revisit limit for ${overRevisit.join(", ")}` };
  }
  return { allowed: true };
}
