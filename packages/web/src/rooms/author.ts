/**
 * Author identity for the group stream (I8 / AC9.2).
 *
 * Why this file exists at all: `messageProjection.ts:383-399` turns every Pi
 * `role: "custom"` transcript message into a `ThreadMessageLike` whose
 * **role is `"assistant"`**, with the payload carried as
 *
 *   content: [ { type:"data", name:"pi-custom-message", data:{ customType, details } },
 *              ...projected text/image parts ]
 *
 * so `role` says nothing about who spoke. A room message from 高见远 and a
 * flow-guard system notice are the *same role* on both sides of the wire. The
 * only honest signals are `customType` and `details`, which is exactly what
 * `packages/server/src/pi-room-thread.ts` writes (I7). Reading `role` and
 * guessing would let the UI claim a guard notice was said by an agent — the
 * Q40 lie this task must not ship.
 *
 * Everything here is pure and total: unknown shapes degrade to
 * `authorKind: "unknown"` (visually neutral, never an agent avatar) instead of
 * throwing or inventing a person.
 */

import type { AuthorKind, RoomAgent, RoomMessage } from "./types";

/** I7's `customType` values (`pi-room-thread.ts`). The browser twin. */
export const ROOM_AGENT_CUSTOM_TYPE = "room-agent";
export const ROOM_SYSTEM_CUSTOM_TYPE = "room-system";
/** The `data` part name react-pi's projector emits for a custom message. */
export const PI_CUSTOM_MESSAGE_PART = "pi-custom-message";

/** The I7 `RoomMessageDetails` shape, as seen from the browser. */
export interface RoomAuthor {
  authorKind: AuthorKind | "unknown";
  /** True when the identity could not be read, so the UI must say so. */
  degraded: boolean;
  messageId: string | null;
  seq: number | null;
  agentId: string | null;
  name: string;
  role: string;
  emoji: string | null;
  color: string | null;
  isCoordinator: boolean;
  taskId: string | null;
  customType: string | null;
}
/** Identity we could not read at all: neutral, never an invented person. */
const UNKNOWN_AUTHOR: RoomAuthor = {
  authorKind: "unknown",
  degraded: true,
  messageId: null,
  seq: null,
  agentId: null,
  name: "未知作者",
  role: "",
  emoji: null,
  color: null,
  isCoordinator: false,
  taskId: null,
  customType: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const nullableStr = (value: unknown): string | null =>
  value === null || value === undefined ? null : str(value);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean => value === true;

const AUTHOR_KINDS: readonly string[] = ["user", "agent", "system"];

/** Which `authorKind` a `customType` implies, when details are unusable. */
const kindFromCustomType = (customType: string | null): AuthorKind | null => {
  if (customType === ROOM_SYSTEM_CUSTOM_TYPE) return "system";
  if (customType === ROOM_AGENT_CUSTOM_TYPE) return "agent";
  return null;
};

/**
 * Parse one `pi-custom-message` data part. `customType` and `details` are both
 * consulted, and `details.authorKind` wins when it is a known value: it is the
 * finer signal (it exists for user rows too), while a rename of `customType` on
 * the server would otherwise strand the UI.
 */
export function parseRoomAuthor(part: unknown): RoomAuthor {
  if (!isRecord(part) || part.type !== "data" || part.name !== PI_CUSTOM_MESSAGE_PART) {
    return UNKNOWN_AUTHOR;
  }
  const payload = isRecord(part.data) ? part.data : {};
  const customType = str(payload.customType);
  const details = isRecord(payload.details) ? payload.details : null;

  const declaredKind = details ? str(details.authorKind) : null;
  const authorKind: AuthorKind | "unknown" =
    declaredKind && AUTHOR_KINDS.includes(declaredKind)
      ? (declaredKind as AuthorKind)
      : kindFromCustomType(customType) ?? "unknown";

  if (!details && authorKind === "unknown") return UNKNOWN_AUTHOR;
  const source = details ?? {};

  const fallbackName =
    authorKind === "system" ? "系统" : authorKind === "user" ? "用户" : authorKind === "agent" ? "未知成员" : "未知作者";

  return {
    authorKind,
    // An agent turn whose name we cannot read is a degraded identity: it must
    // not be dressed up as some specific persona.
    degraded: details === null || (authorKind === "agent" && str(source.name) === null),
    messageId: nullableStr(source.messageId),
    seq: num(source.seq),
    agentId: nullableStr(source.agentId),
    name: str(source.name) ?? fallbackName,
    role: str(source.role) ?? "",
    emoji: nullableStr(source.emoji),
    color: nullableStr(source.color),
    isCoordinator: bool(source.isCoordinator),
    taskId: nullableStr(source.taskId),
    customType,
  };
}

/** The parts a projected message carries, structurally (runtime *or* our own projection). */
export interface MessagePartLike {
  type: string;
  name?: string;
  data?: unknown;
  text?: string;
}


/** The visible text of a message, concatenated across text parts. */
export function textOfParts(parts: readonly MessagePartLike[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Author from a raw `/api/rooms/:id/messages` row (fallback mode, same model). */
export function authorFromRoomMessage(message: RoomMessage, agents: readonly RoomAgent[]): RoomAuthor {
  const agent =
    message.authorKind === "agent" && message.authorAgentId
      ? agents.find((candidate) => candidate.id === message.authorAgentId)
      : undefined;
  if (message.authorKind === "agent") {
    return {
      authorKind: "agent",
      // A vanished persona keeps its id as the only evidence of who spoke — the
      // same rule I7 applies in `roomMessageDetails`.
      degraded: !agent,
      messageId: message.id,
      seq: message.seq,
      agentId: message.authorAgentId,
      name: agent?.name ?? message.authorAgentId ?? "未知成员",
      role: agent?.role ?? "",
      emoji: agent?.emoji ?? null,
      color: agent?.color ?? null,
      isCoordinator: agent?.isCoordinator ?? false,
      taskId: message.taskId,
      customType: ROOM_AGENT_CUSTOM_TYPE,
    };
  }
  if (message.authorKind === "system") {
    return {
      authorKind: "system",
      degraded: false,
      messageId: message.id,
      seq: message.seq,
      agentId: null,
      name: "系统",
      role: "",
      emoji: null,
      color: null,
      isCoordinator: false,
      taskId: message.taskId,
      customType: ROOM_SYSTEM_CUSTOM_TYPE,
    };
  }
  return {
    authorKind: "user",
    degraded: false,
    messageId: message.id,
    seq: message.seq,
    agentId: null,
    name: "用户",
    role: "",
    emoji: null,
    color: null,
    isCoordinator: false,
    taskId: message.taskId,
    customType: null,
  };
}

/**
 * A member row as an author: the member panel and the `@` picker have a
 * `RoomAgent`, not a stream row, and the avatar must not be built twice.
 */
export function authorFromAgent(agent: RoomAgent): RoomAuthor {
  return {
    authorKind: "agent",
    degraded: false,
    messageId: null,
    seq: null,
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    emoji: agent.emoji,
    color: agent.color,
    isCoordinator: agent.isCoordinator,
    taskId: null,
    customType: ROOM_AGENT_CUSTOM_TYPE,
  };
}

/** Named colours imported from a template (`color: indigo`) plus raw CSS colours. */
const NAMED_COLORS: Record<string, string> = {
  indigo: "#4f46e5",
  violet: "#7c3aed",
  purple: "#9333ea",
  fuchsia: "#c026d3",
  pink: "#db2777",
  rose: "#e11d48",
  red: "#dc2626",
  orange: "#ea580c",
  amber: "#b45309",
  yellow: "#ca8a04",
  lime: "#65a30d",
  green: "#16a34a",
  emerald: "#059669",
  teal: "#0d9488",
  cyan: "#0891b2",
  sky: "#0284c7",
  blue: "#2563eb",
  slate: "#475569",
  gray: "#4b5563",
  grey: "#4b5563",
  stone: "#57534e",
  zinc: "#52525b",
  neutral: "#525252",
};

/** The soft tint behind a named colour, so a badge stays readable. */
const NAMED_TINTS: Record<string, string> = {
  indigo: "#eef0ff", violet: "#f3eefe", purple: "#f8eefe", fuchsia: "#fbe7fd",
  pink: "#fce8f2", rose: "#fdecef", red: "#fdeaea", orange: "#feede0",
  amber: "#fdf2dc", yellow: "#fdf7d5", lime: "#eff6dc", green: "#e6f6ec",
  emerald: "#d9f4ea", teal: "#d8f2ef", cyan: "#d9f2f7", sky: "#dceffa",
  blue: "#e5edff", slate: "#eaeef4", gray: "#eceff2", grey: "#eceff2",
  stone: "#efece8", zinc: "#eeeef0", neutral: "#eeeeee",
};

/**
 * Avatar glyphs: the template's emoji when it has one, else the name's first
 * character (AC9.2). Grapheme-ish trimming keeps a combined emoji (VS16 / ZWJ)
 * from rendering as a fragment, without relying on `Intl.Segmenter` (absent from
 * the ES2022 lib config).
 */
export function avatarGlyph(author: Pick<RoomAuthor, "emoji" | "name">): string {
  const emoji = author.emoji?.trim();
  if (emoji) {
    const units = Array.from(emoji);
    // An emoji is usually one or two code points (base + VS16 / skin tone /
    // ZWJ pieces). Taking the leading units up to a ZWJ keeps the glyph whole
    // without depending on `Intl.Segmenter`, which is not in the ES2022 lib.
    const firstJoin = units.indexOf("\u200d");
    const head = firstJoin < 0 ? units.slice(0, 2) : units.slice(0, firstJoin);
    return head.join("") || "?";
  }
  const name = author.name.trim();
  return name === "" ? "?" : Array.from(name)[0]!;
}
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\(/i;

/** Deterministic fallback hue for an unknown colour name. */
const hashColor = (seed: string): string => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 42%)`;
};

const tintOf = (color: string): string => `color-mix(in srgb, ${color} 14%, #ffffff)`;

/**
 * The two colours that make an agent visually distinguishable (AC9.2). An
 * unusable colour is hashed from the agent's own identity rather than defaulting
 * to one shared accent, so two agents missing colours still differ.
 */
export function authorColors(author: RoomAuthor): { color: string; soft: string } {
  const raw = author.color?.trim().toLowerCase() ?? "";
  const named = NAMED_COLORS[raw];
  if (named) return { color: named, soft: NAMED_TINTS[raw] ?? tintOf(named) };
  if (HEX.test(raw) || FUNCTIONAL.test(raw)) return { color: raw, soft: tintOf(raw) };
  const seed = author.agentId ?? author.name ?? "room";
  const color = hashColor(seed);
  return { color, soft: tintOf(color) };
}
