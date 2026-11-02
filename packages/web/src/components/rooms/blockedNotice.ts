/**
 * The 201-with-blocks notice (Q40 semantics).
 *
 * A guard block is a *result*, not a failure: the user message and the system
 * message that explains the refusal are already committed in the same
 * transaction, so the stream — not an error banner — is where the reason
 * belongs. This helper only formats the count/names line the chat area shows
 * above that stream; it never claims the send failed.
 *
 * Codes come from `evaluateTrigger` (`room-guards.ts`): TERMINATED / LOOP /
 * ROUND_CAP, and the `reason` text is exactly what the server wrote into the
 * system message.
 */

import type { RoomPostMessageResult } from "../../rooms/types";

const CODE_LABEL: Record<string, string> = {
  TERMINATED: "已终止",
  LOOP: "循环",
  ROUND_CAP: "轮次上限",
};

/** The inline note text the group chat area shows after a 201-with-blocks send. */
export function alertBlockedText(
  blocked: RoomPostMessageResult["blocked"],
  agentName?: (id: string) => string,
): string | null {
  if (blocked.length === 0) return null;
  const detail = blocked
    .map((block) => {
      const label = CODE_LABEL[block.code] ?? block.code;
      const who = agentName ? agentName(block.memberId) : block.memberId;
      return `${who}（${label}）`;
    })
    .join("、");
  return `流程守卫拦下 ${blocked.length} 个触发：${detail}。系统提示已写入消息流；你的消息也已记录，这不是发送失败。`;
}
