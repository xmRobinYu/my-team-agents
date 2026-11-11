import { CliAdapter, type CliKind } from "@my-team-agents/runtime-cli";
import type { CanonicalEvent, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { PiAdapter } from "@my-team-agents/runtime-pi";

export function runtimeFor(memberId: string): RuntimeAdapter {
  if (process.env.MTA_RUNTIME === "mock" || memberId === "mock-agent") return mockAdapter();
  if (memberId.includes("claude")) return new CliAdapter({ kind: "claude-cli" });
  if (memberId.includes("codex")) return new CliAdapter({ kind: "codex-cli" });
  if (memberId.includes("dsh")) return new CliAdapter({ kind: "dsh-cli" as CliKind });
  return new PiAdapter({ approveProjectResources: true });
}

/** Development-only deterministic runtime; never calls a model or edits files. */
function mockAdapter(): RuntimeAdapter {
  return {
    kind: "pi",
    capabilities: {
      streaming: true, steer: false, cancel: true, approval: "none", sandbox: "none",
      workspacePerRun: true, agentDirPerRun: false, usageAttribution: "message", costCap: false, sessionResume: false,
    },
    async start(spec) {
      let cancelled = false;
      const delay = Number(process.env.MTA_MOCK_DELAY_MS ?? 300);
      // The mock declares `usageAttribution: "message"`, so it must actually emit
      // usage: a capability claim with no events behind it is exactly the bug class
      // the usage-attribution fix (02d532f) was about, and it left the P9c token
      // budget untestable without a paid model.
      const tokens = Number(process.env.MTA_MOCK_USAGE_TOKENS ?? 1_200);
      const usage = {
        input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const events: CanonicalEvent[] = [
        { type: "agent_start", runId: spec.runId, timestamp: new Date().toISOString() },
        { type: "message_end", runId: spec.runId, timestamp: new Date().toISOString(), usage,
          text: JSON.stringify({ outcome: "success", summary: `Mock runtime accepted: ${spec.prompt.slice(0, 160)}`,
            artifacts: [], remainingRisks: ["This is a deterministic development runtime, not an agent response."] }) },
        { type: "agent_settled", runId: spec.runId, timestamp: new Date().toISOString() },
      ];
      return {
        runId: spec.runId,
        events: (async function* () {
          for (const event of events) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
            if (!cancelled) yield event;
          }
        })(),
        settled: (async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delay * events.length));
          return { runId: spec.runId, status: cancelled ? "aborted" as const : "completed" as const };
        })(),
        async cancel() { cancelled = true; },
      };
    },
  };
}
