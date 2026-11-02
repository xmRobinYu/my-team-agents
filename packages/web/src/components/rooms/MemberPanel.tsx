/**
 * Member panel (AC9.4) — the PRD's third column.
 *
 * Roster data is `GET /api/rooms/:id/agents`, the same fetch that feeds the `@`
 * picker, so the panel and the picker cannot disagree about who exists. Clicking
 * a member goes through `useRoomMention()` — the composer's ONE insertion path —
 * which is what makes AC9.4 reuse AC9.3 instead of reimplementing it.
 *
 * Per member the panel shows what the contract actually answers: name, role,
 * coordinator flag, emoji/colour (the identity the template package declared),
 * plus model/thinking when the row carries them. Duplicate names are called out
 * rather than quietly disambiguated, because the backend refuses an ambiguous
 * mention with a 4xx and rolls the message back — hiding that here would mean
 * the user learns about it only when a send fails.
 *
 * Seam: the server exposes no per-member runtime state (installed skills, live
 * status, round usage) on `/api/rooms/:id/agents`. Task counts are therefore
 * derived from the P6 task index the workbench already holds, and anything the
 * panel cannot know is stated, not invented.
 */

import { authorColors, authorFromAgent, avatarGlyph } from "../../rooms/author";
import { duplicateNameCounts } from "../../rooms/mentions";
import type { ChatRoom, RoomAgent } from "../../rooms/types";
import { useRoomMention } from "./MentionBus";
import { RoomAvatar } from "./RoomAvatar";

export interface MemberPanelProps {
  room: ChatRoom | null;
  agents: readonly RoomAgent[];
  loading: boolean;
  error: string | null;
  /** Per-member Task counts from the P6 index (total, and still in flight). */
  taskCounts?: ReadonlyMap<string, { total: number; active: number }>;
}

export function MemberPanel({ room, agents, loading, error, taskCounts }: MemberPanelProps) {
  const mention = useRoomMention();
  const duplicates = duplicateNameCounts(agents);
  const coordinator = room?.coordinatorAgentId
    ? (agents.find((agent) => agent.id === room.coordinatorAgentId) ?? agents.find((agent) => agent.isCoordinator) ?? null)
    : (agents.find((agent) => agent.isCoordinator) ?? null);

  if (!room) {
    return (
      <section className="card member-panel" data-testid="member-panel">
        <header className="card-head">
          <div>
            <h2>成员</h2>
            <p className="card-sub">GET /api/rooms/:id/agents</p>
          </div>
        </header>
        <div className="card-body">
          <p className="empty-hint">左侧选择一个群，这里列出它的 agent、角色与协调者；点击成员即在输入框插入 @名字。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="card member-panel" data-testid="member-panel">
      <header className="card-head">
        <div>
          <h2>成员面板</h2>
          <p className="card-sub" data-testid="member-summary">
            {room.name} · {agents.length} 个 agent ·{" "}
            {coordinator ? `协调者 ${coordinator.name}` : "本群未指定协调者"}
          </p>
        </div>
        <span className="badge badge-neutral" title="轮次上限（Q30/AC5.4，按群配置）">
          上限 {room.maxRounds} 轮
        </span>
      </header>

      {error ? (
        <div className="card-body">
          <p className="inline-error">成员读取失败：{error}</p>
        </div>
      ) : loading && agents.length === 0 ? (
        <div className="card-body">
          <p className="muted">载入成员中…</p>
        </div>
      ) : agents.length === 0 ? (
        <div className="card-body">
          <p className="empty-hint" data-testid="member-empty">
            本群还没有 agent。导入团队包后这里会列出成员。
          </p>
        </div>
      ) : (
        <ul className="member-list" data-testid="member-list">
          {agents.map((agent) => {
            const count = duplicates.get(agent.name) ?? 1;
            const colors = authorColors(authorFromAgent(agent));
            const usage = taskCounts?.get(agent.id);
            const author = authorFromAgent(agent);
            return (
              <li key={agent.id} className="member-item" data-testid={`member-${agent.name}`}>
                <button
                  type="button"
                  className="member-trigger"
                  /* 重名不可提及：后端会整条拒绝（AMBIGUOUS_MENTION，事务回滚），
                     所以点击不能造出一个注定失败的草稿——选择器用的是同一条规则。 */
                  onClick={() => {
                    if (count > 1) return;
                    mention(agent);
                  }}
                  disabled={count > 1}
                  aria-disabled={count > 1}
                  title={`在输入框插入 @${agent.name}`}
                  style={{ borderColor: colors.color }}
                  data-testid={`member-mention-${agent.name}`}
                >
                  <RoomAvatar author={author} size="md" label={`${agent.name} ${agent.role}`} />
                  <span className="member-main">
                    <span className="member-name-row">
                      <span className="member-name">{agent.name}</span>
                      {agent.isCoordinator ? (
                        <span className="badge badge-warning" title="轮次超限时由平台下发强制收尾（AC5.1）">
                          协调者
                        </span>
                      ) : null}
                      {count > 1 ? (
                        <span className="badge badge-danger" title="群里有重名成员：后端会拒绝这条 @提及（AMBIGUOUS_MENTION）">
                          重名 ×{count}
                        </span>
                      ) : null}
                    </span>
                    <span className="member-role">{agent.role.trim() === "" ? "（模板未声明角色）" : agent.role.trim()}</span>
                    <span className="member-meta muted mono">
                      <span
                        className="member-swatch"
                        style={{ background: colors.color }}
                        title={agent.color ? `color: ${agent.color}` : "模板未声明颜色，按 id 派生"}
                        aria-hidden="true"
                      />
                      {agent.emoji ? agent.emoji : `无 emoji → 首字「${avatarGlyph(agent)}」`}
                      {" · "}
                      {agent.model ?? "模型跟随运行时"}
                      {agent.thinkingMode ? ` · 思考 ${agent.thinkingMode}` : ""}
                      {usage ? ` · 任务 ${usage.active}/${usage.total}` : ""}
                    </span>
                    <span className="member-hint">
                      {count > 1 ? "重名无法提及：请先让成员名字唯一" : `点击插入 @${agent.name}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="foot-note">
        群规则（导入自模板包，仅本群生效）：
        <pre className="prompt-body room-rules" data-testid="room-rules">
          {room.rules.trim() === "" ? "（无）" : room.rules.trim()}
        </pre>
      </div>
    </section>
  );
}
