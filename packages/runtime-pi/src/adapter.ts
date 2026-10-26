/**
 * Pi adapter — the core agent loop.
 *
 * Drives `pi --mode rpc` as a long-lived child process: strict JSONL framing on
 * stdin (one JSON object per line, LF-terminated) and JSONL events on stdout
 * (docs/rpc.md). The command set used here is from docs/rpc-commands.md:
 *   prompt / abort / clear_queue / get_session_stats
 *
 * Trust: RPC mode cannot show Pi's interactive trust prompt, so this adapter
 * ALWAYS passes an explicit --approve/--no-approve. Without it, whether project
 * .pi/, AGENTS.md, and extensions load depends on a saved decision (docs/security.md).
 * Trust does not constrain tool access — isolation comes from the process/container.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeAdapter, RuntimeCapabilities, RunHandle, RunResult, RunSpec } from "@my-team-agents/runtime-core";
import type { CanonicalEvent, Usage } from "@my-team-agents/runtime-core";

type JsonRecord = Record<string, unknown>;

/** Maps a Pi JSON event type onto the canonical contract. Unknown names stay visible. */
function canonicalType(raw: string): { type: CanonicalEvent["type"]; rawType?: string } {
  switch (raw) {
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "queue_update":
    case "compaction_start":
    case "auto_retry_start":
    case "auto_retry_end":
      return { type: raw };
    case "extension_error":
      return { type: "error" };
    default:
      return { type: "unknown", rawType: raw };
  }
}

function toUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const u = value as JsonRecord;
  const cost = (typeof u.cost === "object" && u.cost !== null ? u.cost : {}) as JsonRecord;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    totalTokens: num(u.totalTokens),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total),
    },
  };
}

function textOf(record: JsonRecord): string | undefined {
  const ev = record.assistantMessageEvent;
  if (typeof ev === "object" && ev !== null) {
    const e = ev as JsonRecord;
    if (typeof e.delta === "string") return e.delta;
    if (typeof e.content === "string") return e.content;
  }
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    const content = (message as JsonRecord).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is JsonRecord => typeof c === "object" && c !== null)
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
    }
  }
  return undefined;
}

export interface PiAdapterOptions {
  /** Explicit always. Never leave trust to a saved decision in a non-interactive host. */
  approveProjectResources: boolean;
  /** Extra Pi args (e.g. --tools, --model). */
  extraArgs?: string[];
  spawn?: typeof spawn;
}

export class PiAdapter implements RuntimeAdapter {
  readonly kind = "pi" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    steer: true,
    cancel: true,
    approval: "none",
    sandbox: "none",
    workspacePerRun: true,
    agentDirPerRun: false,
    usageAttribution: "message",
    costCap: false,
  };

  constructor(private readonly options: PiAdapterOptions) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    const args = ["--mode", "rpc", "--no-session"];
    args.push(this.options.approveProjectResources ? "--approve" : "--no-approve");
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    if (this.options.extraArgs) args.push(...this.options.extraArgs);

    const spawnFn = this.options.spawn ?? spawn;
    const child = spawnFn("pi", args, { cwd: spec.workspacePath });

    const events = this.streamEvents(child, spec.runId);
    const settled = this.settle(child, spec.runId, events.done);

    // Kick off the run. `prompt` resolving means accepted, NOT completed (docs/rpc.md).
    this.send(child, { id: `${spec.runId}:prompt`, type: "prompt", message: spec.prompt });

    return {
      runId: spec.runId,
      events: events.iterable,
      cancel: async (signal = "abort") => {
        if (signal === "clear-queue") this.send(child, { type: "clear_queue" });
        this.send(child, { type: "abort" });
      },
      settled,
    };
  }

  private send(child: ChildProcessWithoutNullStreams, record: JsonRecord): void {
    child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private streamEvents(
    child: ChildProcessWithoutNullStreams,
    runId: string,
  ): { iterable: AsyncIterable<CanonicalEvent>; done: Promise<void> } {
    let buffer = "";
    let push: (e: CanonicalEvent) => void = () => {};
    let close: () => void = () => {};
    let fail: (err: Error) => void = () => {};

    const queue: CanonicalEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      close = () => resolve();
      fail = reject;
      push = (e) => queue.push(e);
    });

    let waiting: ((value: IteratorResult<CanonicalEvent>) => void) | null = null;
    const notify = () => {
      if (waiting && queue.length > 0) {
        const w = waiting;
        waiting = null;
        // biome-ignore lint/style/noNonNullAssertion: guarded by length check
        w({ value: queue.shift()!, done: false });
      } else if (waiting && finished) {
        const w = waiting;
        waiting = null;
        w({ value: undefined, done: true });
      }
    };

    let finished = false;
    const finish = () => {
      finished = true;
      close();
      notify();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        let record: JsonRecord;
        try {
          record = JSON.parse(line) as JsonRecord;
        } catch {
          continue; // Non-protocol noise on stdout is not fatal; RPC frames are JSON.
        }
        const rawType = typeof record.type === "string" ? record.type : "";
        const { type, rawType: unknownRaw } = canonicalType(rawType);
        const tool = typeof record.toolName === "string" ? record.toolName : undefined;
        push({
          type,
          ...(unknownRaw ? { rawType: unknownRaw } : {}),
          runId,
          timestamp: new Date().toISOString(),
          ...(textOf(record) !== undefined ? { text: textOf(record) } : {}),
          ...(tool ? { toolName: tool } : {}),
          ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
          ...(toUsage(record.usage) ? { usage: toUsage(record.usage) } : {}),
          ...(typeof record.model === "string" ? { model: record.model } : {}),
          ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
          ...(type === "error"
            ? { isError: true, error: typeof record.error === "string" ? record.error : "extension_error" }
            : {}),
        });
        notify();
      }
    });

    child.on("error", (err) => fail(err));
    child.stdout.on("end", finish);
    child.on("exit", finish);

    const iterable: AsyncIterable<CanonicalEvent> = {
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

    return { iterable, done };
  }

  private async settle(
    child: ChildProcessWithoutNullStreams,
    runId: string,
    done: Promise<void>,
  ): Promise<RunResult> {
    await done;
    return { runId, status: "completed" };
  }
}
