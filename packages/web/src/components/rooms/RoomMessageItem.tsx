/**
 * One turn of the shared stream (AC9.2).
 *
 * The author comes from the projected identity model, never from the message
 * `role`: react-pi has already rewritten every Pi `custom` row into an assistant
 * message, so `role` cannot tell an agent's turn from a flow-guard notice. The
 * three tones below are the visible consequence:
 *
 *  - `agent`   — avatar + name + role, tinted with the member's own colour.
 *  - `user`    — the operator's own words: no avatar, no member colour.
 *  - `system`  — a platform notice (守卫提示 / 终止提示). Full-width, dashed,
 *                prefixed 「系统」, NO person's face anywhere on it. A guard note
 *                dressed as an agent turn would tell the user the agent said
 *                something the platform decided (Q40), which is the exact lie
 *                AC9.2 was written to prevent.
 *  - `unknown` — identity unreadable: drawn neutrally and labelled as such
 *                instead of being assigned to somebody.
 */

import type { RoomAuthor } from "../../rooms/author";
import { authorColors, textOfParts } from "../../rooms/author";
import type { RoomTurn } from "../../rooms/project";
import { formatClock } from "../../lib/format";
import { RoomAvatar } from "./RoomAvatar";

/** Flow-guard prefixes written by the server (`formatBlockReason` / I6 notices). */
const GUARD_PREFIX = /^\s*【([^】]{1,16})】/;

const guardLabel = (content: string): string | null => {
  const match = GUARD_PREFIX.exec(content);
  return match?.[1] ?? null;
};

export function RoomMessageItem({ turn }: { turn: RoomTurn }) {
  const text = textOfParts(turn.parts);
  const tone = toneOf(turn.author);
  const time = turn.createdAt === null ? "—" : formatClock(turn.createdAt);
  const guard = tone === "system" ? guardLabel(text) : null;

  return (
    <article
      className={`room-msg room-msg-${tone}`}
      data-testid={`room-msg-${tone}`}
      data-author-kind={turn.author.authorKind}
      data-agent-id={turn.author.agentId ?? ""}
      data-seq={turn.seq ?? ""}
      aria-label={`${turn.author.name} 的消息`}
    >
      <header className="room-msg-meta">
        {tone === "agent" ? (
          <>
            <RoomAvatar author={turn.author} size="sm" />
            <span className="room-msg-author" style={{ color: authorColors(turn.author).color }}>
              {turn.author.name}
            </span>
            {turn.author.role.trim() !== "" ? (
              <span className="room-msg-role">{turn.author.role.trim()}</span>
            ) : null}
            {turn.author.isCoordinator ? (
              <span className="badge badge-warning" title="本群协调者（轮次超限时负责收尾）">
                协调者
              </span>
            ) : null}
          </>
        ) : tone === "system" ? (
          <>
            <span className="room-msg-system-mark" aria-hidden="true">
              ⚙
            </span>
            <span className="room-msg-author">系统{guard ? ` · ${guard}` : ""}</span>
            <span className="badge badge-neutral">平台提示，不是成员发言</span>
          </>
        ) : tone === "user" ? (
          <span className="room-msg-author">我（用户）</span>
        ) : (
          <>
            <span className="room-msg-author">身份未署名</span>
            <span className="badge badge-warning">无法确认作者</span>
          </>
        )}
        <span className="room-msg-time mono">{time}</span>
      </header>
      <div className="room-msg-body">
        {text === "" ? <p className="room-msg-empty">（无文本内容）</p> : <p>{text}</p>}
        {turn.taskId ? (
          <p className="room-msg-task muted mono">
            由任务 <span title={turn.taskId}>{shortId(turn.taskId)}</span> 产生
          </p>
        ) : null}
      </div>
    </article>
  );
};

const toneOf = (author: RoomAuthor): "agent" | "user" | "system" | "unknown" => {
  switch (author.authorKind) {
    case "agent":
      // A persona that was deleted from the room keeps its id as the only
      // evidence of who spoke (that is what I7 puts in `details.name`). It is
      // still an agent turn — dressing it as the system, or as anonymous, would
      // rewrite history. Only an agent row with NO identity at all is unknown.
      return author.degraded && author.agentId === null ? "unknown" : "agent";
    case "user":
      return "user";
    case "system":
      return "system";
    default:
      return "unknown";
  }
};

const shortId = (id: string): string => (id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`);
