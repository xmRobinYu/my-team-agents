/**
 * Flow guards for a ChatRoom (I6): loop detection, round cap and the termination
 * signal.
 *
 * Pure by construction — state in, decision out, no database, no clock, no model.
 * That is what makes AGENTS.md's hard rule ("护栏判定必须确定性") checkable: the
 * same `RoomState` always yields the same verdict, so a guard can never be
 * negotiated by an agent that phrases its reply persuasively. Termination is a
 * platform decision recorded by code; the LLM only supplies the marker.
 *
 * Q28/Q29: the state itself lives in SQLite (`RoomStore`), never in an in-memory
 * Map, so a restart keeps the rounds, the chain and `terminated`.
 */

import type { ChatRoom, RoomAgent, RoomState } from "@my-team-agents/domain";
import { TERMINATION_MARKER } from "@my-team-agents/domain";

export type GuardBlockCode = "TERMINATED" | "LOOP" | "ROUND_CAP";

export interface TriggerDecision {
  allowed: boolean;
  code?: GuardBlockCode;
  /** 人类可读原因，直接写进系统消息 */
  reason?: string;
  /** 这次触发是否正好把轮次顶到上限（用于给 Coordinator 加强制收尾指令） */
  reachesCap?: boolean;
}

/**
 * Should this agent be allowed to trigger right now?
 *
 * The order is fixed, and it matters:
 *  1. `TERMINATED` — the discussion was closed by the coordinator. Nothing else
 *     is even considered, so a loop-free, sub-cap trigger still cannot resurrect
 *     a finished room (AC6.1).
 *  2. `LOOP` — the agent is already in this turn's chain. Checked before the cap
 *     because "A→B→A" is a defect worth naming even when rounds remain (AC4.1),
 *     and a legal chain user→A→B→coordinator has no repeats, so it passes (AC4.3).
 *  3. `ROUND_CAP` — the budget for this user turn is spent (AC5.2).
 *  4. Otherwise allowed, and `reachesCap` says whether THIS trigger is the one
 *     that exhausts the budget, which is what schedules the forced wrap-up (AC5.1).
 *
 * A room with a nonsensical cap (<= 0) blocks every trigger rather than silently
 * allowing one: the guard errs on the side of stopping, and `maxRounds` reaching
 * the guard un-normalised is a configuration error worth surfacing.
 */
export function evaluateTrigger(
  state: RoomState,
  room: ChatRoom,
  targetAgentId: string,
): TriggerDecision {
  if (state.terminated) {
    return {
      allowed: false,
      code: "TERMINATED",
      reason: `本群讨论已结束（协调者已输出 ${TERMINATION_MARKER}），后续 agent 触发被阻断；用户发送新消息可重新开始`,
    };
  }
  if (state.chain.includes(targetAgentId)) {
    // No id dump in the reason: this text is posted into a chat stream, and a chain
    // of `agent-…` uuids is unreadable. The path the room already took is visible in
    // the messages above, and `formatBlockReason` names the target that was refused.
    return {
      allowed: false,
      code: "LOOP",
      reason: `该 agent 已在本轮对话链中（本轮已触发 ${state.roundCount} 轮），循环守卫阻断这次触发，避免 A→B→A 无限互 @`,
    };
  }
  if (state.roundCount >= room.maxRounds) {
    return {
      allowed: false,
      code: "ROUND_CAP",
      reason: `本轮已达轮次上限（${state.roundCount}/${room.maxRounds}），不再处理新的 agent 触发；用户发送新消息后轮次重置`,
    };
  }
  return {
    allowed: true,
    reachesCap: state.roundCount + 1 >= room.maxRounds,
  };
}

export interface TerminationDecision {
  terminate: boolean;
  ignoredAttempt: boolean;
}

/**
 * Does this reply end the room? Only the coordinator's word does (AC6.1/AC6.2):
 * any other agent that types `[讨论结束]` is having its attempt to close the
 * discussion ignored, and `ignoredAttempt` is what tells the caller to record a
 * warn plus a system message instead of terminating.
 */
export function evaluateTermination(content: string, agent: RoomAgent): TerminationDecision {
  if (typeof content !== "string" || !content.includes(TERMINATION_MARKER)) {
    return { terminate: false, ignoredAttempt: false };
  }
  return agent.isCoordinator
    ? { terminate: true, ignoredAttempt: false }
    : { terminate: false, ignoredAttempt: true };
}

/**
 * The system-message text for one blocked trigger. `targetName` comes from the
 * caller (it already has the agent or can look it up), because a chain of opaque
 * `agent-…` ids is unreadable in a chat stream and the point of the system message
 * is that a human can see *why* nobody answered.
 */
export function formatBlockReason(targetName: string, decision: TriggerDecision): string {
  const code = decision.code ?? "LOOP";
  const label = code === "TERMINATED"
    ? "已终止"
    : code === "ROUND_CAP" ? "轮次上限" : "循环";
  return `【流程守卫·${label}】${targetName}：${decision.reason ?? "触发被阻断"}`;
}

/** The instruction the coordinator must receive when the cap is reached (AC5.1). */
export const WRAP_UP_INSTRUCTION = [
  "# 强制收尾指令（平台发出，不是群成员的意见）",
  `轮次已达上限，本轮讨论到此为止：不要再派发或 @ 其他成员。`,
  `请立即汇总当前共识与遗留分歧并收尾，summary 中必须包含 ${TERMINATION_MARKER}。`,
  `输出 ${TERMINATION_MARKER} 后平台会终止本群后续触发；不输出则下一条 agent 触发将被轮次上限阻断。`,
].join("\n");
