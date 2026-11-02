/**
 * The `@` member picker (AC9.3) — presentational.
 *
 * Keyboard state lives in the composer, because focus never leaves the textarea:
 * a popover that swallowed keys by listening on itself would simply never see
 * them. The composer routes ArrowUp/ArrowDown/Enter/Tab/Escape here while the
 * popover is open, and `aria-activedescendant` on the textarea points at the
 * highlighted option so a screen reader follows the selection.
 *
 * Duplicated names are the case the list must not be trusted to resolve: the
 * backend refuses `AMBIGUOUS_MENTION` with a 4xx and rolls the message back, so
 * the marked entry is rendered but disabled — selecting it could only produce a
 * doomed request, and silently picking one of two same-named personas would be
 * worse (that is the upstream teamagentx behaviour we explicitly do not copy).
 */

import { avatarGlyph, authorFromAgent } from "../../rooms/author";
import type { RoomAgent } from "../../rooms/types";
import { RoomAvatar } from "./RoomAvatar";

export interface MentionPickerProps {
  candidates: readonly RoomAgent[];
  /** Index of the highlighted option; `-1` when the list is empty. */
  highlight: number;
  /** Names shared by more than one member. */
  duplicates: ReadonlyMap<string, number>;
  query: string;
  onHover: (index: number) => void;
  onPick: (agent: RoomAgent) => void;
}

const optionId = (index: number) => `mention-opt-${index}`;

export function MentionPicker({ candidates, highlight, duplicates, query, onHover, onPick }: MentionPickerProps) {
  return (
    <div className="mention-popover" data-testid="mention-popover" data-query={query} id="mention-popover">
      <div className="mention-head">
        <span>提及成员</span>
        <span className="muted">↑↓ 选择 · Enter/Tab 确认 · Esc 关闭</span>
      </div>
      {candidates.length === 0 ? (
        <p className="mention-empty" data-testid="mention-empty">
          没有名字匹配 “@{query}” 的成员。
        </p>
      ) : (
        <ul className="mention-list" role="listbox" aria-label="可提及的成员">
          {candidates.map((agent, index) => {
            const count = duplicates.get(agent.name) ?? 1;
            const blocked = count > 1;
            return (
              <li key={agent.id} id={optionId(index)} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  className={`mention-option${index === highlight ? " mention-option-active" : ""}${blocked ? " mention-option-dup" : ""}`}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => {
                    if (blocked) return;
                    onPick(agent);
                  }}
                  disabled={blocked}
                  aria-disabled={blocked}
                  data-testid={`mention-option-${agent.name}`}
                  title={blocked ? `群里有 ${count} 个同名成员，后端会拒绝这条提及` : agent.role}
                >
                  <RoomAvatar author={authorFromAgent(agent)} size="sm" />
                  <span className="mention-name">{agent.name}</span>
                  {!agent.emoji ? (
                    <span className="mention-glyph muted" aria-hidden="true">
                      {avatarGlyph({ emoji: agent.emoji, name: agent.name })}
                    </span>
                  ) : null}
                  {agent.role.trim() !== "" ? <span className="mention-role">{agent.role.trim()}</span> : null}
                  {agent.isCoordinator ? (
                    <span className="badge badge-warning" title="轮次超限时负责收尾">
                      协调者
                    </span>
                  ) : null}
                  {blocked ? <span className="badge badge-danger">重名 ×{count}，不可选</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export { optionId };
