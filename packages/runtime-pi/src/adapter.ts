/**
 * Pi adapter — the core agent loop.
 *
 * Drives `pi --mode rpc` as a long-lived child process: strict JSONL framing on
 * stdin (one JSON object per line, LF-terminated) and JSONL events on stdout
 * (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md — upstream pi package
 * docs, not a file in this repo). The command set used here is from
 * node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md:
 *   prompt / abort / clear_queue / get_state
 *
 * Trust: RPC mode cannot show Pi's interactive trust prompt, so this adapter
 * ALWAYS passes an explicit --approve/--no-approve, which overrides everything.
 * Without it, whether protected project resources (.pi/settings.json, .pi/mcp.json,
 * extensions) load falls back to a saved decision or defaultProjectTrust; context
 * files such as AGENTS.md load either way
 * (node_modules/@earendil-works/pi-coding-agent/docs/security.md).
 * Trust does not constrain tool access — isolation comes from the process/container.
 *
 * Skills (AC8.2/I9): every loadable skill directory in `spec.agentDir` is handed to
 * Pi as its own `--skill <dir>`; see `./skills.ts` for why discovery alone cannot
 * work for a persona directory.
 *
 * Structured handoff (D1/I10): Pi 1.4.0 ships `read`/`bash`/`edit`/`write` and nothing
 * else, so `handoff_to` does not exist until we declare it. It arrives as an explicit
 * `--extension <path>` pointing at the uncompiled `pi-extensions/handoff-to.js`, which
 * survives both `--no-extensions` and a declined project trust (pi --help: "explicit -e
 * paths still work"). Without that flag the primary dispatch branch of
 * `orchestrator/durable-worker.ts` is dead code and only the `@name` fallback ever
 * fires — see `./handoff-extension.ts`.
 *
 * Session isolation (D3/I10): `agentDir` was only ever the spawn `cwd`, while Pi wrote
 * every transcript to the shared `~/.pi/agent/sessions`, so one persona could read
 * another room's conversation with `read`/`bash`. A run that has a persona dir now also
 * gets `--session-dir <agentDir>/.pi/sessions`; resume with `--session <path>` still
 * works (measured) — see `./session-isolation.ts`.
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeAdapter, RuntimeCapabilities, RunHandle, RunResult, RunSpec } from "@my-team-agents/runtime-core";
import type { CanonicalEvent, Usage } from "@my-team-agents/runtime-core";
import { handoffExtensionPath } from "./handoff-extension.js";
import { piSessionDirArgs } from "./session-isolation.js";
import { piSkillDirs } from "./skills.js";

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
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "bash_execution_update":
      return { type: raw };
    case "extension_error":
      return { type: "error" };
    default:
      return { type: "unknown", rawType: raw };
  }
}

/**
 * Model attribution: the `(provider, model)` pair a usage report belongs to.
 *
 * Either half may be missing — Pi's `Usage` object carries no attribution at all
 * (node_modules/@earendil-works/pi-ai/dist/types.d.ts:285-303), so a report is only
 * attributable through the message it came with.
 */
interface ModelAttribution {
  provider?: string;
  model?: string;
}

/**
 * Read attribution off an assistant message.
 *
 * Why the message and not the event: Pi's RPC/JSON writers never put `model` or
 * `provider` on the top level of a session record — verified against real session
 * files where 0 of 31 assistant events carried either key. Attribution lives on
 * `AssistantMessage.provider` / `.model` / `.responseModel`
 * (node_modules/@earendil-works/pi-ai/dist/types.d.ts:368-381). Reading the top level
 * is not just useless, it is misleading: it looks like a working fallback while every
 * usage row silently lands in `(attempt_id,'unknown','unknown')`, and because
 * `ExecutionStore.appendEvent` upserts with MAX() (cumulative usage), two models inside
 * one Attempt would then collapse into a single row whose total understates both.
 *
 * `model` prefers `responseModel`: that is upstream's own aggregation key
 * (`provider` / `responseModel ?? model`, node_modules/@earendil-works/pi-coding-agent/
 * dist/core/usage-totals.js:47). Using the requested `model` instead would attribute a
 * routed/virtual model's tokens to a name the provider never billed, so our breakdown
 * would disagree with Pi's.
 */
function attributionOf(message: unknown): ModelAttribution | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as JsonRecord;
  // Only assistant messages are model responses; user/toolResult entries have no
  // provider/model and must not overwrite the attribution of the reply they precede.
  if (m.role !== "assistant") return undefined;
  const provider = typeof m.provider === "string" && m.provider.length > 0 ? m.provider : undefined;
  const model = typeof m.responseModel === "string" && m.responseModel.length > 0
    ? m.responseModel
    : typeof m.model === "string" && m.model.length > 0
      ? m.model
      : undefined;
  if (provider === undefined && model === undefined) return undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) };
}

/**
 * `agent_end` carries the run's messages instead of a single `message`, so the last
 * assistant entry is the one the usage reported so far belongs to.
 */
function lastAssistantAttribution(messages: unknown): ModelAttribution | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const found = attributionOf(messages[i]);
    if (found) return found;
  }
  return undefined;
}

/**
 * `get_state` replies with `RpcSessionState`, whose `model` is the session's active
 * model descriptor: `{ provider, id, ... }` (node_modules/@earendil-works/pi-coding-agent/
 * dist/modes/rpc/rpc-types.d.ts:148-159). This is the only attribution source available
 * *before* the first message, which is what makes the first `message_update` reportable.
 */
function attributionFromModelDescriptor(model: unknown): ModelAttribution | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const m = model as JsonRecord;
  const provider = typeof m.provider === "string" && m.provider.length > 0 ? m.provider : undefined;
  const id = typeof m.id === "string" && m.id.length > 0 ? m.id : undefined;
  if (provider === undefined && id === undefined) return undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(id !== undefined ? { model: id } : {}) };
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

/**
 * Name the real cause of a failed `spawn("pi", ...)`.
 *
 * Node reports a missing working directory with the SAME `ENOENT` /
 * `syscall: "spawn pi"` / `path: "pi"` it uses for a missing binary -- measured
 * against the real runtime. That conflation cost a full investigation: the
 * message reads "pi is not installed", so the obvious response is to reinstall
 * pi, which cannot fix a deleted persona directory. It is the same class of
 * misattribution recorded in CONTEXT.md Q45 ("PATH 错配说成未安装").
 *
 * `PiAdapter` spawns with `cwd: agentDir ?? workspacePath`, and `agentDir` is
 * data -- it comes from `room_agents.agent_dir`, which template import writes and
 * an operator can delete out from under a room. So the cwd is checked here, at
 * the one point where the error is already in hand, rather than pre-flight in
 * `start()`: a pre-flight check would reject the synthetic `agentDir` paths that
 * most adapter tests pass, turning a diagnostic into a behavioural change.
 */
export function spawnFailureMessage(error: unknown, cwd: string): string {
  const base = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code !== "ENOENT") return base;
  if (!existsSync(cwd)) {
    return `${base} -- 但 \`pi\` 本身可执行；真正原因是工作目录不存在：${cwd}`
      + `（room_agents.agent_dir 指向的 persona 目录已被删除或从未导入）`;
  }
  return `${base} -- 工作目录 ${cwd} 存在，所以这是 \`pi\` 不在 PATH 上`
    + `（不是未安装：见 scripts/resolve-bin.mjs 与 CONTEXT.md Q45）`;
}

export interface PiAdapterOptions {
  /** Explicit always. Never leave trust to a saved decision in a non-interactive host. */
  approveProjectResources: boolean;
  /** Extra Pi args (e.g. --tools, --model). */
  extraArgs?: string[];
  spawn?: typeof spawn;
  /**
   * D1: declare the `handoff_to` tool by loading our Pi extension. Default true.
   * `false` is the escape hatch that restores the pre-D1 command line exactly; it is
   * what proves the new flags are additive rather than a rewrite of the old argv.
   */
  handoffExtension?: boolean;
  /** Extension file override (tests only). Default resolves from this module's URL. */
  handoffExtensionPath?: string;
  /**
   * D3: keep Pi's session files inside `spec.agentDir` via `--session-dir`. Default
   * true, and only ever applied when the run HAS a persona dir — a workspace-only
   * Task keeps the upstream session behaviour byte-for-byte.
   */
  isolatePersonaSessions?: boolean;
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
    // I3: the persona dir takes effect as the spawn cwd, so it is genuinely per-run.
    agentDirPerRun: true,
    usageAttribution: "message",
    costCap: false,
    sessionResume: true,
  };

  constructor(private readonly options: PiAdapterOptions) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    const args = ["--mode", "rpc"];
    // Ephemeral runs write nothing, so there is no session file to isolate.
    let ephemeralSession = false;
    if (spec.session?.sessionPath) {
      // Resume the original session WITH history: --session <path> loads it,
      // --session-id alone only selects a file and starts with empty context.
      args.push("--session", spec.session.sessionPath);
    } else if (spec.session?.sessionId) {
      // Fallback: reconstruct path. Pi names files <timestamp>_<uuid>.jsonl,
      // so a bare sessionId cannot always be mapped; prefer sessionPath.
      const sessionPath = `${spec.session.sessionDir}/${spec.session.sessionId}.jsonl`;
      args.push("--session", sessionPath);
    } else if (spec.session?.resume === false) {
      // Explicitly ephemeral: nothing is written, so nothing can be resumed.
      ephemeralSession = true;
      args.push("--no-session");
    }
    // Default: let Pi persist a new session. Passing --no-session unconditionally
    // made resume impossible, because the first run never wrote anything.
    //
    // D3: a persona run keeps those files to itself. `--session-dir` wins over both
    // `PI_CODING_AGENT_SESSION_DIR` and the derived agent-dir default
    // (docs/cli.md:96-97), and it does not disable `--session <path>` above: the pair
    // was measured against the real binary — the file reopened with its history.
    if (this.options.isolatePersonaSessions !== false && !ephemeralSession) {
      args.push(...piSessionDirArgs(spec.agentDir));
    }
    args.push(this.options.approveProjectResources ? "--approve" : "--no-approve");
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    // AC5.2: `--tools` REPLACES Pi's default tool selection, so every tool the run
    // is allowed must be named here. Pi's default is `read,bash,edit,write`; an
    // event-ingress Task names only read-only tools, which is what stops the run
    // from writing anything. A run without `spec.tools` appends nothing, keeping
    // every existing argv byte-identical (pinned by the D1/D3 regression tests).
    //
    // `handoff_to` is ours (D1): it arrives via `--extension`, and `--tools` with
    // plain names replaces the selection WITHOUT touching extension tools unless
    // named. It is listed so the structured-handoff path keeps working on a
    // read-only Task — its `execute()` only records intent for the worker.
    if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
    if (this.options.extraArgs) args.push(...this.options.extraArgs);
    // D1: the handoff extension is a resource injection, so it joins the resource
    // block after extraArgs and before the skills. `--extension` is REPEATABLE and
    // additive, not last-wins: measured with two extensions, the model saw and called
    // both tools. So an `--extension` in extraArgs adds a second extension and does
    // NOT replace this one — use `handoffExtension: false` to actually drop it.
    if (this.options.handoffExtension !== false) {
      args.push("--extension", this.handoffExtensionFile());
    }
    // AC8.2 (I9 defect 2): persona skills never reached Pi. `<agentDir>/skills/`
    // is not one of Pi's discovery roots and `.pi/skills/` is trust-gated, so the
    // only mechanism that works under both --approve and --no-approve is the
    // explicit repeatable `--skill <dir>` (docs/cli.md). Read from the persona dir
    // at spawn time instead of carried on RunSpec: install/uninstall then takes
    // effect on the next trigger with no new field for adapters that cannot honour
    // it. No skills -> nothing appended, so a skill-less Task keeps byte-identical
    // args (pinned by its own regression test).
    for (const skillDir of piSkillDirs(spec.agentDir)) args.push("--skill", skillDir);

    const spawnFn = this.options.spawn ?? spawn;
    // Pi has no --agent-dir switch: `@path` resource discovery, project config and
    // session grouping all key off the working directory (upstream docs/cli.md), so
    // the persona dir can only take effect as cwd. The accepted cost: while an
    // agentDir run is active the agent cannot see the project workspace.
    const cwd = spec.agentDir ?? spec.workspacePath;
    const child = spawnFn("pi", args, { cwd });

    // A holder is used because the settled promise must be created before the
    // parser can call it, and the parser is what sees `agent_settled`.
    const settledHolder: {
      onSettled?: (record: JsonRecord) => void;
      sessionFile?: string;
      onSessionFile?: (file: string) => void;
    } = {};
    // A resumed run already knows its session file; a fresh run learns it from
    // `get_state` (node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md)
    // once Pi has created the session.
    if (spec.session?.sessionPath) settledHolder.sessionFile = spec.session.sessionPath;
    const events = this.streamEvents(child, spec.runId, (record) =>
      settledHolder.onSettled?.(record), (file) => {
      settledHolder.sessionFile = file;
      settledHolder.onSessionFile?.(file);
    });
    const settled = this.settle(child, spec.runId, settledHolder, cwd);

    // Kick off the run. `prompt` resolving means accepted, NOT completed
    // (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md).
    this.send(child, { id: `${spec.runId}:prompt`, type: "prompt", message: spec.prompt,
      ...(spec.images && spec.images.length > 0
        ? { images: spec.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })) }
        : {}),
    });
    // Ask where Pi put the session so the durable store can resume it later.
    this.send(child, { id: `${spec.runId}:state`, type: "get_state" });

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

  /**
   * Absolute path of the `handoff_to` extension for this running module. Resolved
   * from `import.meta.url`, NOT from cwd: from `src/adapter.ts` and from
   * `dist/adapter.js` it lands on the same uncompiled file, which is why one copy
   * serves both vitest (src alias) and production (dist).
   *
   * A missing file is a hard error, never a silent skip. Dropping `--extension`
   * quietly is precisely defect D1: the run still works, the primary handoff path
   * simply does not exist, and nothing anywhere says so.
   */
  private handoffExtensionFile(): string {
    const file = this.options.handoffExtensionPath ?? handoffExtensionPath();
    if (!existsSync(file)) {
      throw new Error(
        `handoff_to extension is missing: ${file}. ` +
          "Pi has no handoff tool of its own, so without this file the structured " +
          "handoff path is dead code. Restore the file or pass handoffExtension: false.",
      );
    }
    return file;
  }

  private send(child: ChildProcessWithoutNullStreams, record: JsonRecord): void {
    child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private streamEvents(
    child: ChildProcessWithoutNullStreams,
    runId: string,
    onSettled?: (record: JsonRecord) => void,
    onSessionFile?: (file: string) => void,
  ): { iterable: AsyncIterable<CanonicalEvent>; done: Promise<void> } {
    let buffer = "";
    let push: (e: CanonicalEvent) => void = () => {};
    let close: () => void = () => {};
    let fail: (err: Error) => void = () => {};

    // Per-run attribution memory. Declared inside streamEvents, which `start()` calls
    // once per run, so it dies with the run: a retried or resumed Attempt can never
    // inherit the previous Attempt's model and mis-attribute its usage — each Attempt
    // gets its own child process and its own closure here.
    //
    // Needed because `message_update` is delta-only on the wire: upstream's
    // `toJsonEvent()` strips the cumulative message
    // (node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js:16-28),
    // leaving `{type, usage, assistantMessageEvent}` — cumulative usage with no
    // attribution attached. Without this memory every streaming report would collapse
    // into the store's single ('unknown','unknown') row.
    const lastKnown: ModelAttribution = {};
    const remember = (found: ModelAttribution | undefined): void => {
      if (!found) return;
      // Halves are remembered independently: a source that only proves the provider
      // must not erase a model learned earlier, and vice versa.
      if (found.provider !== undefined) lastKnown.provider = found.provider;
      if (found.model !== undefined) lastKnown.model = found.model;
    };

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

    /**
     * A spawn/protocol failure has to do MORE than reject `done`.
     *
     * `done` is returned by `streamEvents` and observed by nobody: `start()` hands
     * out `events.iterable` and `settle()`. Rejecting a promise with no handler is
     * an unhandled rejection, and Node >= 15 makes that fatal -- so a Task whose
     * `agentDir` had been deleted took the whole Worker process down with
     * "Error: spawn pi ENOENT" instead of failing that one run. That violates the
     * critical path in AGENTS.md ("a runtime that throws on start() must degrade to
     * failed, never propagate").
     *
     * So: end the stream the same way a normal finish does (otherwise the consumer's
     * `for await` waits forever on a child that will never write), and attach a
     * no-op handler to `done` so the rejection cannot escalate. The error still
     * reaches the caller -- `settle()` listens to the same `error` event and resolves
     * `status: "failed"` with the message, which is what the Worker records.
     */
    const failRun = (err: Error): void => {
      finished = true;
      notify();
      fail(err);
    };
    done.catch(() => {
      // Reported through RunResult.error by `settle()`; handled here only so it
      // cannot escalate into an unhandled rejection.
    });

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
        // `response` is a command reply and `extension_ui_request` an extension
        // interaction, not session activity
        // (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md). They are not model
        // events: pushing them as `unknown` pollutes the transcript and would
        // surface protocol noise to the UI. Session events only.
        if (rawType === "response") {
          const data = record.data;
          if (typeof data === "object" && data !== null) {
            const state = data as JsonRecord;
            const file = state.sessionFile;
            if (typeof file === "string" && file.length > 0) onSessionFile?.(file);
            // `get_state` reports the session's active model. It is the only source
            // available before the first message, so it is what makes the very first
            // `message_update` attributable rather than 'unknown'.
            remember(attributionFromModelDescriptor(state.model));
          }
          continue;
        }
        if (rawType === "extension_ui_request") continue;
        if (rawType === "agent_settled") onSettled?.(record);
        const { type, rawType: unknownRaw } = canonicalType(rawType);
        const tool = typeof record.toolName === "string" ? record.toolName : undefined;
        // Resolve attribution for this record, then feed it back into the memory so a
        // later delta-only `message_update` inherits it.
        const recordAttribution = attributionOf(record.message) ?? lastAssistantAttribution(record.messages);
        remember(recordAttribution);
        const resolvedAttribution: ModelAttribution = {
          model: recordAttribution?.model ?? lastKnown.model,
          provider: recordAttribution?.provider ?? lastKnown.provider,
        };
        push({
          type,
          ...(unknownRaw ? { rawType: unknownRaw } : {}),
          runId,
          timestamp: new Date().toISOString(),
          ...(textOf(record) !== undefined ? { text: textOf(record) } : {}),
          ...(tool ? { toolName: tool } : {}),
          ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
          ...(record.args !== undefined ? { args: record.args } : {}),
          ...(toUsage(record.usage) ? { usage: toUsage(record.usage) } : {}),
          // Attribution never comes from the top level of the record — see
          // `attributionOf`. Order: this record's message, then `agent_end`'s message
          // array, then whatever this run has already learned.
          ...(resolvedAttribution.model !== undefined ? { model: resolvedAttribution.model } : {}),
          ...(resolvedAttribution.provider !== undefined ? { provider: resolvedAttribution.provider } : {}),
          ...(type === "error"
            ? { isError: true, error: typeof record.error === "string" ? record.error : "extension_error" }
            : {}),
        });
        notify();
      }
    });

    child.on("error", (err) => failRun(err));
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

  private settle(
    child: ChildProcessWithoutNullStreams,
    runId: string,
    holder: { onSettled?: (record: JsonRecord) => void; sessionFile?: string },
    cwd: string,
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        const sessionFile = holder.sessionFile;
        if (child.exitCode === null && !child.killed) child.kill();
        resolve(sessionFile ? { ...result, sessionFile } : result);
      };
      // `agent_settled` is the only completion signal: `agent_end` closes one
      // low-level run while Pi may still retry, compact, or process queued work.
      holder.onSettled = (record: JsonRecord) => {
        finish({ runId, status: record.aborted === true ? "aborted" : "completed" });
      };
      child.on("error", (error) =>
        finish({ runId, status: "failed", error: spawnFailureMessage(error, cwd) }));
      child.on("exit", (code, signal) => {
        finish({ runId, status: signal ? "aborted" : "failed",
          error: `Pi exited before agent_settled (${code ?? signal ?? "unknown"})` });
      });
    });
  }
}
