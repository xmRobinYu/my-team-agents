/**
 * Member avatar (AC9.2): the template's emoji when it declared one, otherwise the
 * name's first character, always tinted with that member's own colour.
 *
 * The colour is what makes two agents distinguishable at a glance in a busy
 * stream, so it is applied to the ring and the glyph background together. A
 * system turn never gets an avatar of this kind — see `RoomMessageItem`.
 */

import { authorColors, avatarGlyph, type RoomAuthor } from "../../rooms/author";

export type AvatarSize = "sm" | "md";

export function RoomAvatar({
  author,
  size = "md",
  label,
}: {
  author: RoomAuthor;
  size?: AvatarSize;
  /** Override the accessible name (e.g. the member panel adds the role). */
  label?: string;
}) {
  const { color, soft } = authorColors(author);
  const glyph = avatarGlyph(author);
  const title = label ?? (author.agentId ? `${author.name}（${author.agentId}）` : author.name);
  return (
    <span
      className={`avatar avatar-${size} avatar-agent`}
      style={{ background: soft, borderColor: color, color }}
      title={title}
      aria-label={title}
      role="img"
    >
      <span className="avatar-glyph" aria-hidden="true">
        {glyph}
      </span>
    </span>
  );
}

/** A row of member avatars, used by the conversation list to show a room's roster. */
export function RoomAvatarStack({ authors, limit = 5 }: { authors: readonly RoomAuthor[]; limit?: number }) {
  const shown = authors.slice(0, limit);
  const rest = authors.length - shown.length;
  return (
    <span className="avatar-stack" aria-hidden="true">
      {shown.map((author, index) => (
        <span
          key={`${author.agentId ?? author.name}-${index}`}
          className="avatar avatar-sm avatar-agent"
          style={{
            background: authorColors(author).soft,
            borderColor: authorColors(author).color,
            color: authorColors(author).color,
          }}
          title={author.name}
        >
          <span className="avatar-glyph">{avatarGlyph(author)}</span>
        </span>
      ))}
      {rest > 0 ? <span className="avatar avatar-sm avatar-more">+{rest}</span> : null}
    </span>
  );
}
