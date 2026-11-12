import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { CanonicalEvent, RunSpec, RuntimeAdapter } from "@my-team-agents/runtime-core";
import { DEFAULT_GUARDRAILS, TERMINATION_MARKER, evaluateHandoff } from "@my-team-agents/domain";
import type { ChatRoom, RoomAgent } from "@my-team-agents/domain";
import { ExecutionStore, type AttemptRecord, type TaskRecord, type TaskResult } from "./execution-store.js";
import { hasWritableTools } from "./ingest.js";
import { personaThinking } from "./persona-thinking.js";
import { dedupeByOrigin, parseHandoffArgs, type DispatchOrigin } from "./handoff-intent.js";
import { handoffResolutionNotes, type ResolutionNote } from "./worker-notes.js";
import { latestText, parseResult, unknownHighRiskTools } from "./worker-result.js";
import { resolveMentions, resolveRosterTokens } from "./mention.js";
import { evaluateTermination, evaluateTrigger, formatBlockReason } from "./room-guards.js";
import {
  buildDispatchPrompt,
  queueWrapUpTask,
  snapshotDispatch,
  type DispatchSnapshot,
  type DispatchSource,
} from "./room-trigger.js";
import type { RoomStore } from "./room-store.js";
import { classifyRuntimeError, type FailureKind } from "./failure-kind.js";

export interface WorkerOptions {
  workerId?: string;
  adapterFor(memberId: string): RuntimeAdapter;
  /**
   * I4: rooms the worker writes agent replies into. Only group-chat Tasks
   * (`groupId` set) touch it, so a worker without it still runs every other Task
   * exactly as before.
   */
  rooms?: RoomStore;
  leaseMs?: number;
  idleTimeoutMs?: number;
  /**
   * P9c: stop this Task once its accumulated usage crosses either ceiling and put
   * it in `blocked` — not `failed`, and not `retry_wait`. The usage is summed over
   * ALL Attempts of the Task, so a retry cannot reset the meter.
   */
  budget?: { maxTokens?: number; maxCost?: number };
  /**
   * P9b: called after a Task settles into `blocked`/`failed`. The implementation is
   * the tell service; the worker only knows that SOMEONE may need to be told, which
   * keeps the outbound transport out of the execution kernel.
   */
  tell?: (taskId: string) => void | Promise<void>;
  now?: () => number;
  onChange?: () => void;
}

export interface ResolvedHandoff {
  /**
   * Idempotency anchor. For the primary path this is the runtime's real tool call
   * id; for the `@name` path there is no tool call, so the worker synthesises
   * `mention:<source Task id>` — see `mentionSourceId`.
   */
  sourceToolCallId: string;
  toMemberId: string;
  reason: string;
  /** Which dispatch path produced it (Q34). Decides the dedup winner (Q35). */
  origin: DispatchOrigin;
  input: {
    tenantId: string;
    projectId: string;
    memberId: string;
    workspacePath: string;
    prompt: string;
    /** Target persona dir (I3/Q38); only ever set for group Tasks. */
    agentDir?: string;
    groupId?: string;
    model?: string;
  };
}

/**
 * One recorded refusal: the `【…】` label the stream shows, plus the text behind
 * it. Both dispatch paths produce notes, and the label keeps the two kinds apart —
 * 提及解析 is an unresolvable `@name` in prose (I5), 交接校验 is a `handoff_to`
 * target this room does not declare (D5).
 */
interface DispatchEntry {
  memberId: string;
  name: string;
  agent: RoomAgent | null;
}

/**
 * I6: the guard verdicts for one batch of handoffs, computed BEFORE the commit
 * transaction and written INSIDE it (see `planRoomGuards`).
 */
interface GuardPlan {
  roomId: string;
  room: ChatRoom;
  /** Handoffs the guards allowed; these become child Tasks. */
  kept: ResolvedHandoff[];
  /** Handoffs the guards refused; each gets a system message, no Task. */
  blocked: Array<{ memberId: string; reason: string }>;
  /** Some allowed handoff lands exactly on `maxRounds` (AC5.1). */
  reachesCap: boolean;
  /** Projected round count after all allowed handoffs of this batch. */
  rounds: number;
  /**
   * I5/D5: what a dispatch path resolved but did NOT dispatch — an unknown or
   * ambiguous `@name` on the secondary path, or a `handoff_to` target this room
   * does not declare on the primary path (D5-a). Recorded, never fatal: see the
   * asymmetry note on `collectMentionHandoffs` and `resolveHandoffTargets`.
   * `label` is what the stream shows, so a roster refusal is never mistaken for a
   * prose refusal.
   */
  notes: ResolutionNote[];
}

export interface DurableWorker {
  runOnce(): Promise<boolean>;
  recoverExpired(): number;
  requestCancel(taskId: string): { affected: number; attemptId: string | null };
}

/** Conservative P6 recovery: durable events, bounded attempts and fenced writes. */
export function createDurableWorker(store: ExecutionStore, options: WorkerOptions): DurableWorker {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const now = options.now ?? Date.now;
  const onChange = options.onChange ?? (() => {});
  /**
   * P9c: a per-Task ceiling on tokens or cost. Optional, and unset means unset —
   * a default would silently stop long legitimate runs.
   */
  const budget = options.budget;
  const active = new Map<string, { attempt: AttemptRecord; chainId: string }>();
  const rooms = options.rooms;
  // Same rule as `postRoomMessage`: the reply and the Task row must share one
  // database handle, otherwise "task succeeded" and "reply landed" cannot commit
  // together. Checked once up front instead of failing mid-run.
  if (rooms && rooms.db !== store.db) {
    throw new Error("createDurableWorker needs RoomStore and ExecutionStore over one database handle");
  }

  /**
   * I4: post the agent's reply into the shared room stream, so the next trigger
   * injects what this agent actually said. Without this the "history" would only
   * ever contain user messages and group chat would be an illusion.
   *
   * Content is `structured.summary`: the worker only reaches here with a validated
   * structured result, so `summary` is the one field guaranteed to be non-empty
   * human-readable prose. The raw `latestText` may be a JSON envelope, which is
   * unreadable as a chat message.
   *
   * Idempotent by `taskId`: a replay or a retried Attempt re-injects the same
   * history and must not make the agent speak twice.
   *
   * The return value is what I6 needs: `true` means THIS call wrote the reply, so
   * the flow-state writes that follow (rounds, termination) run exactly once per
   * Task. Without it, a replay of a successful Task would count its rounds twice.
   */
  function appendAgentReply(task: TaskRecord, result: TaskResult): boolean {
    if (!rooms || !task.groupId) return false;
    if (rooms.getMessageByTask(task.id)) return false;
    rooms.appendMessage({
      roomId: task.groupId,
      authorKind: "agent",
      // `memberId` IS the RoomAgent id for group Tasks (see postRoomMessage).
      authorAgentId: task.memberId,
      content: result.summary,
      taskId: task.id,
    }, now());
    return true;
  }

  /**
   * I6 entry point C — the termination signal, read off the reply that was just
   * written. Only the coordinator can end a room (AC6.1); anyone else typing
   * `[讨论结束]` has the attempt ignored, with a warn AND a system message so the
   * stream itself shows why nothing stopped (AC6.2).
   *
   * The marker is data in a chat log; the flag is written by code. That is the
   * AGENTS.md rule in force: an agent can propose an ending, it cannot decide one.
   */
  function applyTermination(task: TaskRecord, result: TaskResult): void {
    if (!rooms || !task.groupId) return;
    const agent = rooms.getAgent(task.memberId);
    if (!agent) {
      // A group Task whose persona is gone cannot be judged as coordinator or not.
      // Leaving the room running is the safe direction, and the reply is still in
      // the stream, so nothing is silently dropped.
      console.warn(`[room-guards] ${task.groupId}: 无法判定终止 — 找不到 agent ${task.memberId}`);
      return;
    }
    const decision = evaluateTermination(result.summary, agent);
    if (decision.terminate) {
      rooms.markTerminated(task.groupId, now());
      rooms.appendMessage({
        roomId: task.groupId,
        authorKind: "system",
        content: `【流程守卫·终止】协调者 ${agent.name} 宣布讨论结束，本群后续 agent 触发将被阻断；用户发送新消息可重新开始。`,
      }, now());
      return;
    }
    if (decision.ignoredAttempt) {
      console.warn(
        `[room-guards] ${task.groupId}: 非协调者 ${agent.name} 输出了 ${TERMINATION_MARKER}，已忽略（终止权只在协调者）`,
      );
      rooms.appendMessage({
        roomId: task.groupId,
        authorKind: "system",
        content: `【流程守卫·终止】${agent.name} 不是本群协调者，其 ${TERMINATION_MARKER} 被忽略，讨论继续。`,
      }, now());
    }
  }

  /**
   * The persona a dispatch target actually runs as (I3/Q38). A group Task's
   * `memberId` IS a RoomAgent id, so the child must inherit that agent's own
   * `agentDir` (Pi's child cwd — persona isolation) and `model`; a child without
   * them silently runs in the project workspace with the parent's model, which
   * breaks G2/G3 of the PRD and Q38's isolation rule.
   *
   * Deliberately only for group Tasks: a non-group `memberId` is an execution
   * member with no persona row, and inheriting the PARENT's `agentDir` would be
   * worse still — the child would run as the wrong person.
   */
  function personaFields(task: TaskRecord, memberId: string): { agentDir?: string; model?: string } {
    if (!rooms || !task.groupId) return {};
    const agent = rooms.getAgent(memberId);
    if (!agent) return {};
    return {
      ...(agent.agentDir ? { agentDir: agent.agentDir } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    };
  }


  /**
   * Idempotency anchor for the `@name` path. There is no tool call, so the id is
   * synthesised — and it must be STABLE across an Attempt replay, because
   * `completeSuccess` dedupes children on `outbox(source_tool_call_id,
   * target_member_id)` and on `idempotencyKey handoff:<chain>:<source>:<target>`.
   * `task.id` is the durable row the replay re-claims, so `mention:<taskId>` names
   * exactly one source message forever; a crash between commit and ack cannot queue
   * a second child. `randomUUID()` or `Date.now()` would mint a fresh key per
   * replay and silently double-dispatch.
   */
  const mentionSourceId = (taskId: string): string => `mention:${taskId}`;

  /**
   * D5-a: the roster check the PRIMARY dispatch path never had.
   *
   * `handoff_to` hands the platform a list of strings the model chose. Until now
   * those strings went straight into `evaluateHandoff` and
   * `ResolvedHandoff.toMemberId` unexamined, so a target the room does not contain
   * was dispatched anyway: the child Task got `member_id="寇豆码"` (a name, not an
   * id), `agent_dir=NULL` and `model=NULL` from `personaFields`' silent `{}`
   * fallback, and spun in the project workspace as an anonymous agent. That is a
   * silent mis-dispatch, and a real acceptance run proved it.
   *
   * So every declared token is resolved against `rooms.listAgents(task.groupId)`
   * with `resolveRosterTokens` — the same id/name/role rules the `@name` path
   * already uses (D2: name before role; a token two members answer to is
   * `ambiguous` and is never guessed). A token that resolves to nobody is refused
   * with a system message, not dropped quietly and not made fatal: the parent's run
   * produced a valid structured result and stays `succeeded`, exactly the asymmetry
   * `collectMentionHandoffs` documents for prose.
   *
   * Guardrails then see the RESOLVED member ids, which is the only correct input:
   * `revisit ≤ 5` counts visits per member id, so a chain that reaches 寇豆码 three
   * times via the token `工程师` must be stopped by the same rule as one reaching
   * `agent-<uuid>` three times. Fanout is judged on what would actually dispatch —
   * never more than what was declared, so refusing junk names shrinks it.
   *
   * A Task with no `groupId` has no roster to check (its `memberId` is an execution
   * member, not a persona) and a worker with no `RoomStore` cannot read one: both
   * return the tokens verbatim, so the P6 spine stays byte-identical.
   */
  function resolveHandoffTargets(
    tokens: string[],
    members: RoomAgent[] | null,
  ): {
    entries: DispatchEntry[];
    /** Declared tokens no member of this room answers to. */
    unknown: string[];
    /** Declared tokens more than one member answers to. */
    ambiguous: string[];
  } {
    // No roster to read — a Task without a `groupId`, a worker without a RoomStore,
    // or a room that no longer exists: the tokens pass through verbatim, exactly as
    // the P6 spine always did. Inventing a gate here would change what a roomless
    // Task means by "member", and there is nothing to check it against.
    if (members === null) {
      return {
        entries: tokens.map((token) => ({ memberId: token, name: token, agent: null })),
        unknown: [],
        ambiguous: [],
      };
    }
    const { targets, unknown, ambiguous } = resolveRosterTokens(tokens, members);
    return {
      entries: targets.map((agent) => ({ memberId: agent.id, name: agent.name, agent })),
      unknown,
      ambiguous,
    };
  }

  /**
   * D5-a: the system messages the roster produced for this run, folded by token
   * across every `handoff_to` call so one bad name costs one sentence instead of
   * one per call — the same fold the mention path applies to an unresolvable `@`.
   *
   * Phrased in the existing guard vocabulary (`【…】…：…，未派发`) and named 交接校验
   * rather than 提及解析: a refusal the MODEL asked for by calling a tool is not the
   * same fact as a name in its prose, and the room has to be able to tell which path
   * to fix. The sentence says 不是本群成员, because that is the actual finding — the
   * target may exist elsewhere and simply not be in THIS room.
   */

  /**
   * D6: the child Task input BOTH agent-dispatch paths build. One function, so
   * "what a triggered colleague sees" cannot drift between `handoff_to` and `@name`
   * the way it had: the primary path used to hand over nothing but the work text,
   * so the child ran without its persona prompt, without the room and without any
   * history (AC2.3/AC3.1), which Q30/I4 forbid.
   *
   * `snapshot` is the run's single room read (see `readSnapshot` in `execute`),
   * `work` is the `handoff_to` `workPackage`/`reason`. The snapshot renders the
   * injection and `work` is appended AFTER it as the dispatcher's instruction to the
   * target, the way `queueWrapUpTask` appends the platform directive last. A `@name`
   * child has no work text, so it gets the injection unchanged.
   *
   * A null snapshot — a Task with no `groupId`, a worker with no `RoomStore`, or a
   * room that has vanished — keeps the old bare `work` prompt: there is no room to
   * inject in any of those cases, and the P6 spine's behaviour must not move.
   */
  function dispatchInput(
    task: TaskRecord,
    entry: DispatchEntry,
    snapshot: DispatchSnapshot | null,
    work: string,
  ): ResolvedHandoff["input"] {
    return {
      tenantId: task.tenantId, projectId: task.projectId, memberId: entry.memberId,
      workspacePath: task.workspacePath,
      prompt: snapshot && entry.agent
        ? buildDispatchPrompt(snapshot, entry.agent, work)
        : work,
      ...(task.groupId ? { groupId: task.groupId } : {}),
      // I5/bug-C: a group child must run AS its own persona, not in the parent's
      // workspace with the parent's model.
      ...personaFields(task, entry.memberId),
      ...personaThinking(rooms, task, entry.memberId),
    };
  }

  /**
   * I5 entry point — the SECONDARY dispatch path (Q34): a `@name` inside the
   * agent's own reply.
   *
   * The parsed text is `structured.summary`, i.e. exactly what `appendAgentReply`
   * puts into the shared stream: what triggers a colleague and what that colleague
   * can see are the same bytes, so a mention can never be "spoken" in the room
   * without being honoured, or honoured without being visible.
   *
   * **The asymmetry against `postRoomMessage` is deliberate, not an oversight.**
   * A *user* message with an unknown or ambiguous `@` is a bad request: nothing is
   * written and the API answers 4xx (AC2.5), because the human must be told right
   * away that nobody will answer. An *agent* reply is the output of work that has
   * already cost a run: `@某人` may be narration ("上次 @老王 提过这个") or a name
   * that does not exist in this room. Failing the Task would throw away a
   * successful run over a text glitch, and dropping it in silence would be the
   * invisible no-op the 4xx exists to avoid. So: the run still succeeds, and the
   * unresolved names are answered in the stream as one system note.
   *  - `unknown`  → recorded, never dispatched, never fatal;
   *  - `ambiguous`→ recorded and NOT dispatched: with two candidates in the room
   *    there is no way to choose, and dispatching the wrong persona is worse than
   *    a declined mention (the same reasoning that makes the user path refuse).
   *
   * Guardrails are identical to the primary path on purpose: the same
   * `evaluateHandoff` (fanout/depth/budget/revisit) with the budget this batch has
   * already planned, then the same `planRoomGuards` (loop/round cap/termination).
   * A weaker rule for `@` would be a documented way to bypass the budget: swap the
   * tool call for a character.
   *
   * D6: the child is rendered from the run's SHARED snapshot — the same room read a
   * `handoff_to` child is rendered from — so "what a triggered colleague sees" is
   * one implementation for both paths, and one room read per run.
   */
  function collectMentionHandoffs(
    task: TaskRecord,
    text: string,
    planned: number,
    readSnapshot: () => DispatchSnapshot | null,
  ): { handoffs: ResolvedHandoff[]; notes: ResolutionNote[] } {
    const handoffs: ResolvedHandoff[] = [];
    const notes: ResolutionNote[] = [];
    const note = (body: string): void => { notes.push({ label: "提及解析", body }); };
    const snapshot = readSnapshot();
    // No snapshot means no room to read: nothing resolves, nothing dispatches, and
    // no note is written — a stream nobody can append to is not a refusal.
    if (!snapshot || snapshot.members.length === 0) return { handoffs, notes };
    const members = snapshot.members;

    const { targets, unknown, ambiguous } = resolveMentions(text, members);
    if (targets.length === 0 && unknown.length === 0 && ambiguous.length === 0) {
      return { handoffs, notes };
    }

    if (unknown.length > 0) note(`群里没有这些成员：@${unknown.join(" / ")}，未派发`);
    if (ambiguous.length > 0) note(`群里有重名成员，无法确定 @${ambiguous.join(" / ")} 指谁，未派发`);
    if (targets.length === 0) return { handoffs, notes };

    const chain = store.getChain(task.chainId);
    // `planned` is what the primary path of THIS reply already reserved. Without
    // it one message could spend the chain budget twice — once per path.
    const budgetUsed = chain.budgetUsed + planned;
    const decision = evaluateHandoff({ depth: task.depth, budgetUsed, visitCounts: chain.visitCounts }, targets.map((a) => a.id));
    if (!decision.allowed) {
      note(`@ 派发的交接链护栏拒绝：${decision.reason ?? "guardrail"}`);
      return { handoffs, notes };
    }
    const remaining = DEFAULT_GUARDRAILS.budgetMax - budgetUsed;
    const affordable = targets.slice(0, Math.max(0, remaining));
    if (affordable.length < targets.length) {
      note(`@ 派发超出剩余预算：${targets.slice(affordable.length).map((a) => a.name).join(" / ")}`);
    }
    const speaker = snapshot.speakerName;
    for (const agent of affordable) {
      handoffs.push({
        sourceToolCallId: mentionSourceId(task.id),
        toMemberId: agent.id,
        // The source message is the only reason the `@` path has.
        reason: `${speaker} 在消息中 @ 了 ${agent.name}`,
        origin: "mention",
        // This path has no work package, so `work` is "" and the child reads the
        // room injection and nothing else.
        input: dispatchInput(task, { memberId: agent.id, name: agent.name, agent }, snapshot, ""),
      });
    }
    return { handoffs, notes };
  }

  /**
   * I6 entry point B — the loop and round guard for agent→agent dispatch.
   *
   * `handoff_to` produces child Tasks (P6) and I5's `@name` path feeds the same
   * batch, so this IS the real interception point for A→B→A on both paths.
   *
   * Read, judgement and write all happen INSIDE the commit transaction
   * (`BEGIN IMMEDIATE`), which is the only shape that is actually correct here:
   *  - a user message posted while this Task was running resets the chain and the
   *    round count. Judging against a snapshot read BEFORE the transaction would
   *    let that reset slip in underneath and charge rounds to a turn that already
   *    ended — so the state is read after the lock is held;
   *  - "this handoff is blocked" + "the system message saying so" + "that round is
   *    counted" + "the child Task exists" commit as one unit. Writing the system
   *    message outside the transaction would let a crash leave a refusal nobody can
   *    see, or a round counted for a child that was never queued.
   *
   * Because a batch can hold several handoffs, each later target is judged against a
   * PROJECTION of the state (`rounds`/`chain` advanced by every allowed target)
   * instead of the snapshot alone. Judging them all against the snapshot would let
   * one reply burn five rounds at once and dispatch the same agent twice in a batch.
   *
   * Returns null when there is nothing to guard: no RoomStore wired, no `groupId`, or
   * the room is gone. A null plan leaves the pure P6 path untouched.
   */
  function planRoomGuards(
    task: TaskRecord,
    handoffs: ResolvedHandoff[],
    notes: ResolutionNote[] = [],
  ): GuardPlan | null {
    // I5: `handoffs` must already be folded by `dedupeByOrigin`. Two paths naming
    // one target would otherwise make the second look like a LOOP here, and LOOP
    // must mean only a real A→B→A.
    if (!rooms || !task.groupId) return null;
    const room = rooms.getRoom(task.groupId);
    if (!room) return null;
    const state = rooms.getState(room.id);
    const kept: ResolvedHandoff[] = [];
    const blocked: GuardPlan["blocked"] = [];
    let rounds = state.roundCount;
    let chain = state.chain;
    let reachesCap = false;
    for (const handoff of handoffs) {
      const decision = evaluateTrigger({ ...state, roundCount: rounds, chain }, room, handoff.toMemberId);
      if (!decision.allowed) {
        const name = rooms.getAgent(handoff.toMemberId)?.name ?? handoff.toMemberId;
        blocked.push({ memberId: handoff.toMemberId, reason: formatBlockReason(name, decision) });
        continue;
      }
      kept.push(handoff);
      rounds += 1;
      chain = [...chain, handoff.toMemberId];
      // The trigger that lands exactly ON the cap is the one that schedules the
      // forced ending, not the ones after it (which are refused by ROUND_CAP).
      if (decision.reachesCap) reachesCap = true;
    }
    return { roomId: room.id, room, kept, blocked, reachesCap, rounds, notes };
  }

  /**
   * Write the plan inside the caller's transaction: one round per handoff that
   * survived, and a system message for each that did not — AC4.1's "在流中显示系统
   * 消息" only holds if the refusal lands together with the refusal.
   *
   * I5/D5: both paths' notes ride along, in the same commit and behind the agent's
   * own reply, so a name the room never got an answer to is visible in the stream
   * instead of quietly dropped. They are not rounds and charge no budget: an
   * unresolvable `@` or a non-member `handoff_to` target dispatched nothing, and
   * counting it would bill the user for a trigger that never happened.
   */
  function applyRoomGuards(plan: GuardPlan): void {
    if (!rooms) return;
    for (const handoff of plan.kept) {
      rooms.recordTrigger(plan.roomId, handoff.toMemberId, now());
    }
    for (const note of plan.notes) {
      rooms.appendMessage({
        roomId: plan.roomId, authorKind: "system", content: `【${note.label}】${note.body}`,
      }, now());
    }
    for (const block of plan.blocked) {
      rooms.appendMessage({ roomId: plan.roomId, authorKind: "system", content: block.reason }, now());
    }
  }

  /**
   * AC5.1 — hitting the cap is not just a refusal, it is a forced ending. The Task
   * is queued by the shared `queueWrapUpTask`, because a user message that mentions
   * enough agents consumes the same budget as a chain of handoffs and AC5.1 does not
   * distinguish the two: one implementation, or the two entry points drift.
   *
   * Called after the reply and the termination check, so if this very reply already
   * ended the room there is nothing to force (the helper re-reads the flag itself).
   */
  function queueWrapUpIfNeeded(task: TaskRecord, plan: GuardPlan): void {
    if (!rooms || !plan.reachesCap) return;
    queueWrapUpTask(rooms, store, {
      room: plan.room,
      rounds: plan.rounds,
      tenantId: task.tenantId,
      projectId: task.projectId,
      workspacePath: task.workspacePath,
      now: now(),
    });
  }

  async function execute(task: TaskRecord, attempt: AttemptRecord): Promise<void> {
    active.set(attempt.id, { attempt, chainId: task.chainId });
    const heartbeat = setInterval(() => {
      if (!store.heartbeat(attempt.id, attempt.fencingToken)) clearInterval(heartbeat);
    }, Math.max(10, Math.min(10_000, leaseMs / 3)));
    heartbeat.unref();
    const events: CanonicalEvent[] = [];
    let lastEventAt = now();
    let failure: string | null = null;
    /** P9c: why `failure` is set. Known at every assignment, so nothing is guessed. */
    let failureKind: FailureKind = "unknown";
    let cancelled = false;

    try {
      store.markAttemptRunning(attempt.id, attempt.fencingToken);
      const adapter = options.adapterFor(task.memberId);
      // P9d: "writable ⇒ isolated" is enforced HERE, not only at registration.
      // Registration is a moment; execution is the fact. A rule accepted while the
      // daemon was up must not keep running unisolated after a restart without it,
      // and a Task written straight into the store never passed registration at all.
      if (task.tools && task.tools.length > 0 && hasWritableTools(task.tools)
          && adapter.capabilities.sandbox === "none") {
        store.finishFailure(attempt.id, attempt.fencingToken,
          `可写工具（${task.tools.join(",")}）需要隔离运行时，但本次 adapter 声明 sandbox=none。`
          + "拒绝执行：未隔离的可写 agent 能读到其它项目工作区与执行库。",
          { kind: "isolation_unavailable", blocked: true, now: now() });
        return;
      }
      const snapshot = task.recoverySnapshot ? `\n\nRecovery snapshot:\n${task.recoverySnapshot}` : "";
      const originalPrompt = (() => {
        if (!task.recoverySnapshot) return task.prompt;
        try {
          const saved = JSON.parse(task.recoverySnapshot) as { originalTask?: unknown };
          return typeof saved.originalTask === "string" ? saved.originalTask : task.prompt;
        } catch { return task.prompt; }
      })();
      const prompt = `${originalPrompt}${snapshot}\n\nAt the end, provide a final JSON result with outcome ("success"|"partial"|"failed"), summary, artifacts (each with path), and remainingRisks.`;
      // Q18: resume the original session when the runtime supports it. Only a
      // retry resumes; the first Attempt has no session yet. The file must still
      // exist, otherwise Pi would start from an empty history silently.
      //
      // Q31 — the group-chat path NEVER resumes: `groupId` forces this false. Each
      // trigger is a clean process that gets the room history re-injected (I4), so a
      // resumed Pi session would hand the same messages over twice. Crash/retry
      // replay works by injecting the same history again, not by restoring Pi's
      // internal state. Session resume stays a Pi adapter capability that Tasks
      // without a room still use.
      const resumeSession = !task.groupId && attempt.sequence > 1
        && adapter.capabilities.sessionResume
        && task.sessionFile && existsSync(task.sessionFile);
      const handle = await adapter.start({
        runId: attempt.id, tenantId: task.tenantId, projectId: task.projectId,
        memberId: task.memberId, workspacePath: task.workspacePath, prompt,
        // I3: persona dir is per-run. Only the runtime that reports agentDirPerRun
        // consumes it; the rest ignore it and keep using workspacePath.
        ...(task.agentDir ? { agentDir: task.agentDir } : {}),
        ...(task.model ? { model: task.model } : {}),
        // AC5.2: an event-ingress Task carries its read-only allowlist; a Task
        // without one keeps the runtime default and byte-identical argv.
        ...(task.tools && task.tools.length > 0 ? { tools: task.tools } : {}),
        ...personaThinking(rooms, task, task.memberId),
        ...(resumeSession
          ? { session: {
              sessionId: basename(task.sessionFile!, ".jsonl"),
              sessionDir: dirname(task.sessionFile!),
              sessionPath: task.sessionFile!,
              resume: true,
            } }
          : {}),
      });
      const watchdog = setInterval(() => {
        if (now() - lastEventAt >= idleTimeoutMs) {
          failure = `no events for ${idleTimeoutMs}ms`;
          failureKind = "idle_timeout";
          void handle.cancel("abort");
        }
        if (!store.heartbeat(attempt.id, attempt.fencingToken, now(), leaseMs)) {
          failure = "lease lost; stop the superseded attempt";
          failureKind = "lease_lost";
          void handle.cancel("abort");
          return;
        }
        if (store.getChain(task.chainId).cancelRequested) {
          cancelled = true;
          void handle.cancel("abort");
        }
      }, Math.min(1000, idleTimeoutMs));
      watchdog.unref();
      try {
        for await (const event of handle.events) {
          lastEventAt = now();
          events.push(event);
          store.appendEvent(attempt.id, attempt.fencingToken, event);
          onChange();
        }
        const result = await handle.settled;
        // Persist the session before deciding the outcome: a failed or cancelled
        // Attempt must still let the next one resume with its history (Q18).
        if (result.sessionFile) {
          store.recordSession(attempt.id, attempt.fencingToken, result.sessionFile);
        }
        if (result.status !== "completed") {
          // The one error string we do not author, so it is classified narrowly.
          failure = failure ?? result.error ?? `runtime ${result.status}`;
          if (failureKind === "unknown") failureKind = classifyRuntimeError(failure);
        }
      } finally {
        clearInterval(watchdog);
      }

      if (cancelled || store.getChain(task.chainId).cancelRequested) {
        store.finishFailure(attempt.id, attempt.fencingToken, "cancel requested",
          { kind: "cancelled", now: now() });
        return;
      }
      // P9c: the budget is checked BEFORE the outcome is interpreted. An agent that
      // ran out of budget mid-run produces a truncated reply, and reading that reply
      // first would report `result_invalid` — blaming the agent for the ceiling.
      const spent = store.getUsage(task.id).reduce(
        (sum, u) => ({ tokens: sum.tokens + u.totalTokens, cost: sum.cost + u.totalCost }),
        { tokens: 0, cost: 0 },
      );
      const overTokens = budget?.maxTokens !== undefined && spent.tokens > budget.maxTokens;
      const overCost = budget?.maxCost !== undefined && spent.cost > budget.maxCost;
      if (overTokens || overCost) {
        const ceiling = overTokens ? `${budget!.maxTokens} tokens` : `${budget!.maxCost} cost`;
        store.finishFailure(attempt.id, attempt.fencingToken,
          `预算超限：本 Task 累计 ${spent.tokens} tokens / ${spent.cost}，上限 ${ceiling}`,
          { kind: "budget_exceeded", now: now() });
        return;
      }
      if (failure) {
        store.finishFailure(attempt.id, attempt.fencingToken, failure,
          { kind: failureKind, now: now() });
        return;
      }
      const unresolved = unknownHighRiskTools(events);
      if (unresolved.length > 0) {
        store.finishFailure(attempt.id, attempt.fencingToken,
          `unknown tool outcomes require human review: ${unresolved.join(", ")}`,
          { kind: "unresolved_tools", blocked: true, now: now() });
        return;
      }
      const reply = latestText(events);
      const structured = parseResult(reply);
      if (!structured) {
        // Two different failures looked identical here. A reply with no text at all,
        // after the runtime retried upstream, means the PROVIDER never answered —
        // reporting "missing valid structured result" blamed the agent for a
        // contract it never had a chance to meet (a real 2026-11-13 session showed
        // this to the user as a bare English error while the Task was retrying).
        // The LAST message_end, not `latestText`: a room run echoes the injected
        // persona/prompt as a user message first, so "the last non-empty text" is
        // that echo — which is how the first version of this branch never fired.
        // An empty final message after Pi's own retries is the provider refusing.
        const lastMessageEnd = [...events].reverse().find((event) => event.type === "message_end");
        const producedNothing = (lastMessageEnd?.text ?? "").trim() === "";
        const refused = producedNothing && events.some((event) => event.type === "auto_retry_start");
        store.finishFailure(attempt.id, attempt.fencingToken,
          refused
            ? "provider 没有返回任何内容（上游限流或不可用），本次尝试已自动重试"
            : "missing valid structured result (outcome, summary, artifacts, remainingRisks)",
          { kind: refused ? "provider_unavailable" : "result_invalid", now: now() });
        return;
      }
      if (structured.outcome === "failed") {
        store.finishFailure(attempt.id, attempt.fencingToken, structured.summary,
          { kind: "agent_failed", now: now() });
        return;
      }

      const handoffs: ResolvedHandoff[] = [];
      const issues: string[] = [];
      // D6: ONE room read per run, memoised, and shared by BOTH dispatch paths. Two
      // reads would let a user message posted while this Task ran give the
      // `handoff_to` children a different history than the `@name` children of the
      // very same reply — two children of one batch disagreeing about what the room
      // said is exactly the drift the "one implementation" rule exists to prevent.
      // Null when there is no room to read (no `groupId`, no RoomStore, no row),
      // which is what keeps a roomless Task's prompt the bare work text.
      let roomRead: DispatchSnapshot | null | undefined;
      const readSnapshot = (): DispatchSnapshot | null => {
        if (roomRead === undefined) {
          const room = rooms && task.groupId ? rooms.getRoom(task.groupId) : null;
          roomRead = rooms && room
            ? snapshotDispatch(rooms, room, {
                taskId: task.id, speakerId: task.memberId,
                text: structured.summary, now: now(),
              })
            : null;
        }
        return roomRead;
      };
      // D5-a: tokens the room does not declare, folded per token across every
      // `handoff_to` call of this run so one bad name costs one system message.
      const rejectedUnknown: string[] = [];
      const rejectedAmbiguous: string[] = [];
      const merge = (list: string[], tokens: string[]): void => {
        for (const token of tokens) if (!list.includes(token)) list.push(token);
      };
      for (const event of events) {
        if (event.type !== "tool_execution_start" || event.toolName !== "handoff_to") continue;
        const parsed = parseHandoffArgs(event.args);
        issues.push(...parsed.issues);
        if (!event.toolCallId) {
          issues.push("handoff has no toolCallId and cannot be dispatched durably");
          continue;
        }
        for (const intent of parsed.intents) {
          const resolved = resolveHandoffTargets(intent.toMemberIds, readSnapshot()?.members ?? null);
          merge(rejectedUnknown, resolved.unknown);
          merge(rejectedAmbiguous, resolved.ambiguous);
          const targets = resolved.entries;
          // Every declared token was refused by the roster: nothing to guard, and
          // the system messages are already queued in `rejected*` — not an `issue`,
          // so the parent's valid run is not voided by a bad name (D5-a).
          if (targets.length === 0) continue;
          const chain = store.getChain(task.chainId);
          const decision = evaluateHandoff(
            { depth: task.depth, budgetUsed: chain.budgetUsed, visitCounts: chain.visitCounts },
            targets.map((entry) => entry.memberId),
          );
          if (!decision.allowed) {
            issues.push(`handoff rejected: ${decision.reason ?? "guardrail"}`);
            continue;
          }
          const remainingBudget = DEFAULT_GUARDRAILS.budgetMax - chain.budgetUsed;
          const affordable = targets.slice(0, Math.max(0, remainingBudget));
          const overBudget = targets.slice(affordable.length);
          if (overBudget.length > 0) {
            issues.push(`handoff rejected: ${overBudget.map((t) => t.name).join(", ")} exceeds remaining chain budget`);
          }
          const args = typeof event.args === "object" && event.args !== null
            ? event.args as Record<string, unknown> : {};
          const work = typeof args.workPackage === "string" ? args.workPackage : intent.reason;
          for (const entry of affordable) {
            handoffs.push({
              sourceToolCallId: event.toolCallId,
              toMemberId: entry.memberId,
              reason: intent.reason,
              origin: "handoff_to",
              // D6/AC3.1 + AC2.3: the SAME injection the `@name` path builds, with
              // `workPackage` appended afterwards. Bare `work` only survives where
              // there is no room to inject (a Task with no `groupId`).
              input: dispatchInput(task, entry, readSnapshot(), work),
            });
          }
        }
      }
      const handoffNotes = handoffResolutionNotes(rejectedUnknown, rejectedAmbiguous);
      // I5 — the secondary path reads the very text the room will see. Its notes
      // are NOT `issues`: an unresolvable `@` in prose must not void a run that
      // produced a valid structured result (that asymmetry is by design, see
      // `collectMentionHandoffs`). Tasks without a `groupId` skip both calls, so
      // the pure P6 path is untouched.
      // The room read is shared, so the secondary path needs no `groupId` guard of
      // its own: with no room it gets a null snapshot and dispatches nothing, exactly
      // as before, and a roomless Task never reaches this line's data path at all.
      const mentions = collectMentionHandoffs(
        task, structured.summary, handoffs.length, readSnapshot,
      );
      // Q35/AC3.3: fold by target BEFORE `evaluateTrigger` ever sees the batch,
      // `handoff_to` winning a tie. Deduping "on the way" through the guards would
      // report the second hit as LOOP, which would be a lie about a loop.
      //
      // Scoped to group Tasks on purpose: per-target dedup is the group-chat rule
      // (Q35 is about the two *dispatch paths* of a room message), and a Task with
      // no `groupId` has only one path. Folding there would change what the P6
      // spine already does with two identical `handoff_to` calls, and its behaviour
      // must stay byte-identical.
      const batch = task.groupId ? dedupeByOrigin([...handoffs, ...mentions.handoffs]) : handoffs;
      if (issues.length > 0 && batch.length === 0) {
        store.finishFailure(attempt.id, attempt.fencingToken, issues.join("; "), { now: now() });
        return;
      }
      // One commit for both facts: a Task that succeeded without its reply in the
      // room — or a reply for a Task that did not succeed — would desynchronise the
      // stream the next trigger injects. `completeSuccess` joins this transaction
      // instead of nesting a second one.
      //
      // I6: the flow guards run inside the SAME transaction, after the state has
      // been read under the write lock. A room-guard refusal is not a runtime
      // failure: the Task still succeeded and still said what it said — only the
      // handoff it asked for is dropped, with a system message as the answer.
      store.transaction(() => {
        const plan = planRoomGuards(task, batch, [...handoffNotes, ...mentions.notes]);
        store.completeSuccess(attempt.id, attempt.fencingToken, structured, plan ? plan.kept : batch, now());
        const spoke = appendAgentReply(task, structured);
        // A Task whose reply is already in the stream has already had its whole
        // effect committed (`spoke` is the idempotency marker), so the flow-state
        // writes below run exactly once per Task: rounds are not counted twice and
        // no system message is duplicated.
        if (!plan || !spoke) return;
        // The order below is the order the room reads in: reply, then the guard's
        // notes about what it refused, then the forced ending if this hit the cap.
        applyRoomGuards(plan);
        applyTermination(task, structured);
        queueWrapUpIfNeeded(task, plan);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { store.finishFailure(attempt.id, attempt.fencingToken, message, { now: now() }); }
      catch { /* A superseded Attempt cannot overwrite the new owner's state. */ }
    } finally {
      clearInterval(heartbeat);
      active.delete(attempt.id);
      onChange();
    }
  }

  return {
    async runOnce() {
      const claimed = store.claimNext(workerId, now(), leaseMs);
      if (!claimed) return false;
      await execute(claimed.task, claimed.attempt);
      // P9b: a Task that ends needing a human is the escalation trigger. Read the
      // FINAL status rather than trusting what `execute` decided, because `execute`
      // has six different exits and a cancelled chain can flip the row underneath it.
      // Fire-and-forget: a slow webhook must not stall the claim loop, and the
      // ledger already makes a lost notification retryable by identity.
      const settled = store.getTask(claimed.task.id);
      if (settled && (settled.status === "blocked" || settled.status === "failed")) {
        void Promise.resolve(options.tell?.(settled.id)).catch(() => { /* ledger holds it */ });
      }
      return true;
    },
    recoverExpired() {
      let recovered = 0;
      for (const attempt of store.expiredAttempts(now())) {
        const task = store.getTask(attempt.taskId);
        const events = task ? store.getEvents(task.id).filter((e) => e.attemptId === attempt.id).map((e) => e.event) : [];
        const unsafe = unknownHighRiskTools(events);
        store.recoverAttempt(attempt.id, `lease expired: ${attempt.id}`, unsafe.length > 0, now());
        recovered += 1;
      }
      if (recovered > 0) onChange();
      return recovered;
    },
    requestCancel(taskId) {
      const task = store.getTask(taskId);
      if (!task) return { affected: 0, attemptId: null };
      const affected = store.requestCancelChain(task.chainId, now());
      const attempt = task.activeAttemptId ? active.get(task.activeAttemptId) : undefined;
      onChange();
      return { affected, attemptId: attempt?.attempt.id ?? task.activeAttemptId };
    },
  };
}
