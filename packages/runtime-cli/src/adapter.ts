/**
 * CLI adapters for claude / codex / dsh — deliberately minimal in v1.
 *
 * V1: spawn a child process, normalize stdout lines into CanonicalEvent, done.
 * No streaming UI fidelity, no mid-run steering, no usage attribution (these
 * CLIs do not give per-message usage in a stable shape), no cost caps.
 * The capability block states this explicitly so the server never offers an
 * action the runtime cannot perform.
 *
 * Verified from `--help` on this machine:
 *   claude: --print -p, --output-format stream-json, --input-format stream-json,
 *           --max-budget-usd, --permission-mode, --json-schema
 *   codex:  exec subcommand, --sandbox read-only|workspace-write|danger-full-access,
 *           -a/--ask-for-approval, --full-auto, -C/--cd
 *   dsh:    a cordis profile launcher (config injection), NOT a coding-agent runtime;
 *           profiles live in ~/.dsh/profiles/<name>/cordis.patch.yml
 *
 * Extension seam: when any of these gains a stable structured stream, fill in
 * `normalizeLine` and flip the capability flags. Nothing else changes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CanonicalEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  RunHandle,
  RunResult,
  RunSpec,
} from "@my-team-agents/runtime-core";

export type CliKind = "claude-cli" | "codex-cli" | "dsh-cli";

const CAPABILITIES: Record<CliKind, RuntimeCapabilities> = {
  "claude-cli": {
    streaming: true,
    steer: false,
    cancel: true,
    approval: "policy",
    sandbox: "none",
    workspacePerRun: true,
    agentDirPerRun: false,
    usageAttribution: "none",
    costCap: true, // --max-budget-usd
  },
  "codex-cli": {
    streaming: true,
    steer: false,
    cancel: true,
    approval: "policy",
    sandbox: "read-only",
    workspacePerRun: true,
    agentDirPerRun: false,
    usageAttribution: "none",
    costCap: false,
  },
  "dsh-cli": {
    streaming: false,
    steer: false,
    cancel: true,
    approval: "none",
    sandbox: "none",
    workspacePerRun: true,
    agentDirPerRun: false,
    usageAttribution: "none",
    costCap: false,
  },
};

export interface CliAdapterOptions {
  kind: CliKind;
  /** Binary name on PATH. */
  command?: string;
  /** dsh profile name (`--profile <name>`), or extra args for claude/codex. */
  extraArgs?: string[];
  spawn?: typeof spawn;
}

function buildArgs(kind: CliKind, spec: RunSpec, extraArgs: string[]): string[] {
  switch (kind) {
    case "claude-cli":
      return ["-p", "--output-format", "stream-json", ...extraArgs, spec.prompt];
    case "codex-cli":
      return ["exec", "--sandbox", "workspace-write", "-C", spec.workspacePath, ...extraArgs, spec.prompt];
    case "dsh-cli":
      return ["--profile", extraArgs[0] ?? "headless", ...extraArgs.slice(1), spec.prompt];
  }
}

/** Minimal normalization: text-ish fields become `text`; everything else is passthrough. */
export function normalizeLine(line: string, runId: string): CanonicalEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    const textCandidate =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.delta === "string"
          ? obj.delta
          : typeof obj.content === "string"
            ? obj.content
            : undefined;
    return {
      // Only names shared with the Pi contract are mapped; the rest stay `unknown`.
      type:
        type === "message_start" || type === "message_end" || type === "message_update"
          ? type
          : type === "error"
            ? "error"
            : "unknown",
      rawType: type || undefined,
      runId,
      timestamp: new Date().toISOString(),
      ...(textCandidate !== undefined ? { text: textCandidate } : {}),
      ...(typeof obj.toolName === "string" ? { toolName: obj.toolName } : {}),
      ...(typeof obj.toolCallId === "string" ? { toolCallId: obj.toolCallId } : {}),
      ...(obj.args !== undefined ? { args: obj.args } : {}),
      ...(typeof obj.error === "string" ? { isError: true, error: obj.error } : {}),
    };
  } catch {
    // Plain-text output: surface as text rather than dropping it.
    return { type: "unknown", rawType: "stdout", runId, timestamp: new Date().toISOString(), text: trimmed };
  }
}

export class CliAdapter implements RuntimeAdapter {
  readonly kind: CliKind;
  readonly capabilities: RuntimeCapabilities;

  constructor(private readonly options: CliAdapterOptions) {
    this.kind = options.kind;
    this.capabilities = CAPABILITIES[options.kind];
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const command = this.options.command ?? this.kind.replace("-cli", "");
    const args = buildArgs(this.kind, spec, this.options.extraArgs ?? []);
    const spawnFn = this.options.spawn ?? spawn;
    const child = spawnFn(command, args, { cwd: spec.workspacePath });

    const queue: CanonicalEvent[] = [];
    let finished = false;
    let waiting: ((v: IteratorResult<CanonicalEvent>) => void) | null = null;

    const push = (e: CanonicalEvent) => {
      queue.push(e);
      if (waiting) {
        const w = waiting;
        waiting = null;
        // biome-ignore lint/style/noNonNullAssertion: guarded by length check
        w({ value: queue.shift()!, done: false });
      }
    };
    const finish = () => {
      finished = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined, done: true });
      }
    };

    const pump = (stream: ChildProcessWithoutNullStreams["stdout"]) => {
      stream.setEncoding("utf8");
      let buf = "";
      stream.on("data", (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
          const ev = normalizeLine(line, spec.runId);
          if (ev) push(ev);
        }
      });
      stream.on("end", () => {
        const ev = normalizeLine(buf, spec.runId);
        if (ev) push(ev);
        finish();
      });
    };
    pump(child.stdout);

    const events: AsyncIterable<CanonicalEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<CanonicalEvent>>((resolve) => {
            if (queue.length > 0) {
              // biome-ignore lint/style/noNonNullAssertion: guarded by length check
              resolve({ value: queue.shift()!, done: false });
            } else if (finished) {
              resolve({ value: undefined, done: true });
            } else {
              waiting = resolve;
            }
          }),
        return: async () => {
          finished = true;
          child.kill();
          return { value: undefined, done: true };
        },
      }),
    };

    const settled = new Promise<RunResult>((resolve) => {
      child.on("exit", (code) => {
        finish();
        resolve({
          runId: spec.runId,
          status: code === 0 ? "completed" : "failed",
          ...(code === 0 ? {} : { error: `exit ${code}` }),
        });
      });
      child.on("error", (err) => {
        finish();
        resolve({ runId: spec.runId, status: "failed", error: err.message });
      });
    });

    return {
      runId: spec.runId,
      events,
      cancel: async () => {
        child.kill();
      },
      settled,
    };
  }
}
