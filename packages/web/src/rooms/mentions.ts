/**
 * `@` mention logic for the group composer (I8 / AC9.3).
 *
 * Two jobs, and both are strict on purpose:
 *
 *  1. **Cursor-aware insertion.** A mention must land where the caret is, not at
 *     the end of the draft, because people write `请 看一下 @架构师` and expect the
 *     `@` they just typed to become the pick.
 *  2. **Pre-send validation.** `POST /api/rooms/:id/messages` refuses a message
 *     with no valid mention (`NO_MENTION`), an unknown `@name`
 *     (`UNKNOWN_MENTION`) or a duplicated room name (`AMBIGUOUS_MENTION`) with a
 *     4xx and a rolled-back transaction. A doomed request is still a round trip
 *     the user pays for, and a 4xx still leaves the draft unsent, so the UI
 *     reproduces the server's rules *before* sending.
 *
 * The rules below mirror `packages/orchestrator/src/mention.ts` exactly, and the
 * mirror is deliberate rather than lazy: the server is authoritative and keeps
 * its own answer (a 4xx from it is still handled), but `resolveMentions` cannot
 * be imported here — the orchestrator's barrel sits behind `node:sqlite`. Every
 * divergence between the two is a bug report, so the character classes, the
 * longest-name-first order and the "preceded-by-address-char" rule are copied
 * literally, with the same reasoning as the original.
 */

import type { RoomAgent } from "./types";

/** A `@` preceded by these is part of an address (`robin@example.com`), not a mention. */
const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;

/** A name followed by these is a longer handle (`@架构师X`), not a mention of `架构师`. */
const HANDLE_CHAR = /[A-Za-z0-9_-]/;

/** Where an unquoted `@token` ends. */
const TOKEN_END = /[\s，。、；：！？,.;:!?/\\|"'“”‘’<>【】[\]{}]/;

const testChar = (re: RegExp, ch: string | undefined): boolean =>
  ch !== undefined && ch !== "" && re.test(ch);

const charAt = (text: string, index: number): string | undefined =>
  index < 0 || index >= text.length ? undefined : text[index];

const tokenEnd = (text: string, start: number): number => {
  let index = start;
  while (index < text.length) {
    if (testChar(TOKEN_END, charAt(text, index))) break;
    index += 1;
  }
  return index;
};

export interface MentionResolution {
  /** Distinct members in first-mention order. */
  targets: RoomAgent[];
  /** `@tokens` that match no member of this room. */
  unknown: string[];
  /** Names that match more than one member, so nobody can be picked safely. */
  ambiguous: string[];
}

/** Browser twin of the server's `resolveMentions`. */
export function resolveRoomMentions(
  content: string,
  agents: readonly RoomAgent[],
): MentionResolution {
  const nameCount = new Map<string, number>();
  for (const agent of agents) nameCount.set(agent.name, (nameCount.get(agent.name) ?? 0) + 1);

  interface Match {
    at: number;
    name: string;
    agent: RoomAgent | null;
  }
  const matches: Match[] = [];
  const byName = [...agents].sort((a, b) => b.name.length - a.name.length);

  for (const agent of byName) {
    if (!agent.name) continue;
    const needle = `@${agent.name}`;
    let from = 0;
    for (;;) {
      const at = content.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      from = end;
      if (matches.some((match) => match.at === at)) continue;
      if (testChar(ADDRESS_CHAR, charAt(content, at - 1))) continue;
      if (testChar(HANDLE_CHAR, charAt(content, end))) continue;
      const duplicated = (nameCount.get(agent.name) ?? 0) > 1;
      matches.push({ at, name: agent.name, agent: duplicated ? null : agent });
    }
  }

  matches.sort((a, b) => a.at - b.at);
  const targets: RoomAgent[] = [];
  const seen = new Set<string>();
  const ambiguous: string[] = [];
  for (const match of matches) {
    if (!match.agent) {
      if (!ambiguous.includes(match.name)) ambiguous.push(match.name);
      continue;
    }
    if (seen.has(match.agent.id)) continue;
    seen.add(match.agent.id);
    targets.push(match.agent);
  }

  const claimed = new Set(matches.map((match) => match.at));
  const unknown: string[] = [];
  for (let at = content.indexOf("@"); at >= 0; at = content.indexOf("@", at + 1)) {
    if (claimed.has(at)) continue;
    if (testChar(ADDRESS_CHAR, charAt(content, at - 1))) continue;
    const end = tokenEnd(content, at + 1);
    if (end === at + 1) continue;
    const token = content.slice(at + 1, end);
    if (!unknown.includes(token)) unknown.push(token);
  }

  return { targets, unknown, ambiguous };
}

/** Why a draft must not be sent, in the server's own vocabulary. */
export type SendBlockCode = "CONTENT_REQUIRED" | "AMBIGUOUS_MENTION" | "UNKNOWN_MENTION" | "NO_MENTION";

export interface SendValidation {
  ok: boolean;
  code?: SendBlockCode;
  /** What to show the user; wording follows the route's 4xx text. */
  message?: string;
  /** The offending `@names`, so the UI can point at them instead of guessing. */
  names?: string[];
  /** Members a send would actually trigger — shown so the effect is not a surprise. */
  targets?: RoomAgent[];
}

/**
 * Gate a draft before it costs a request. Kept in step with `postRoomMessage`'s
 * own order: empty → room (cannot be checked here) → ambiguity → no target.
 */
export function validateRoomDraft(
  content: string,
  agents: readonly RoomAgent[],
): SendValidation {
  if (content.trim() === "") {
    return { ok: false, code: "CONTENT_REQUIRED", message: "消息内容不能为空" };
  }
  const { targets, unknown, ambiguous } = resolveRoomMentions(content, agents);
  if (ambiguous.length > 0) {
    return {
      ok: false,
      code: "AMBIGUOUS_MENTION",
      names: ambiguous,
      message: `群内有重名成员，无法确定 @${ambiguous.join(" / ")} 指谁；后端同样会拒绝这条消息，请先让成员名字唯一`,
    };
  }
  if (targets.length === 0) {
    if (unknown.length > 0) {
      return {
        ok: false,
        code: "UNKNOWN_MENTION",
        names: unknown,
        message: `群里没有这些成员：@${unknown.join(" / ")}；用 @ 从成员列表里选`,
      };
    }
    return {
      ok: false,
      code: "NO_MENTION",
      message: "群里没有 @ 提及的消息不会被任何 agent 处理（后端只接受提及触发），请先 @ 一个成员",
    };
  }
  if (agents.length === 0) {
    return { ok: false, code: "NO_MENTION", message: "本群还没有成员，无法触发任何 agent" };
  }
  return { ok: true, targets };
}

/**
 * The live `@` trigger for the picker: the `@` immediately before the caret
 * whose token has not ended yet. Returns the span to replace plus the filter
 * text typed after the `@`, or null when the caret is not inside a mention.
 *
 * The `@` must start the token — `a@b` is an address, and an `@` already closed
 * by whitespace/punctuation is a finished mention, not a new one.
 */
export interface MentionTrigger {
  /** Index of the `@` in the text. */
  start: number;
  /** Caret index the trigger was found at (the replacement end). */
  end: number;
  /** Text typed after the `@`, used to filter the member list. */
  query: string;
}

export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  if (!Number.isFinite(caret) || caret < 0 || caret > text.length) return null;
  for (let at = caret - 1; at >= 0; at -= 1) {
    const ch = charAt(text, at);
    if (ch === undefined) return null;
    if (ch === "@") {
      if (testChar(ADDRESS_CHAR, charAt(text, at - 1))) return null;
      return { start: at, end: caret, query: text.slice(at + 1, caret) };
    }
    // Any token terminator ends the mention candidate; a newline or space means
    // the `@` the user typed earlier is no longer the one being edited.
    if (testChar(TOKEN_END, ch)) return null;
  }
  return null;
}

/** Members the picker offers for a trigger's query: name first, then role. */
export function filterMentionCandidates(
  agents: readonly RoomAgent[],
  query: string,
  limit = 12,
): RoomAgent[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return agents.slice(0, limit);
  const scored = agents
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => {
      const name = agent.name.toLowerCase();
      const role = (agent.role ?? "").toLowerCase();
      return name.startsWith(needle) || name.includes(needle) || role.includes(needle);
    })
    .sort((a, b) => {
      const an = a.agent.name.toLowerCase();
      const bn = b.agent.name.toLowerCase();
      const starts = Number(bn.startsWith(needle)) - Number(an.startsWith(needle));
      if (starts !== 0) return starts;
      if (an !== bn) return an.length - bn.length;
      return a.index - b.index;
    });
  return scored.map(({ agent }) => agent).slice(0, limit);
}

export interface InsertResult {
  text: string;
  /** Where the caret belongs after the insertion. */
  caret: number;
}

/**
 * Splice `@name` into the draft at the trigger, keeping everything after the
 * caret. A separator is added when the following character is not whitespace,
 * because `@架构师看一下` without a boundary is exactly how a valid mention turns
 * into an unresolvable handle on the server side.
 */
export function insertMentionAtTrigger(
  text: string,
  trigger: MentionTrigger,
  name: string,
): InsertResult {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const needsSpace = after !== "" && !/^\s/.test(after);
  const inserted = `@${name}${needsSpace ? " " : ""}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** The same splice with a bare caret, for "click a member to mention them". */
export function insertMentionAtCaret(
  text: string,
  caret: number,
  name: string,
): InsertResult {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, safeCaret);
  const after = text.slice(safeCaret);
  const needsSpace = after !== "" && !/^\s/.test(after);
  const inserted = `@${name}${needsSpace ? " " : ""}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** How many members share this name — the picker's duplicate warning. */
export function duplicateNameCounts(agents: readonly RoomAgent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
  return counts;
}
