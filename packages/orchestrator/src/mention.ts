/**
 * `@name` mention parsing for ChatRoom user messages (I3).
 *
 * Pure: room agents in, resolved targets out. No DB, no queue — every edge case
 * is unit-testable (`mention.test.ts`).
 *
 * Decisions (also in the I3 report):
 *  - Duplicate names inside one room are `ambiguous`, never "first wins":
 *    silently dispatching the wrong persona is worse than a 4xx.
 *  - `@全体` / `@all` / `@everyone` get no special case: a room has no such
 *    agent, so they land in `unknown` and the caller answers 4xx.
 *  - A bare `@` (followed by nothing) is not a mention.
 *  - `a@b` is not a mention: an ASCII handle before `@` makes it an address.
 *    That keeps `robin@example.com` quiet while `然后@QA` still fires.
 *  - A target named twice is returned once (Q35: dedup by target agent).
 */

import type { RoomAgent } from "@my-team-agents/domain";

export interface MentionResolution {
  /** Distinct agents in first-mention order. */
  targets: RoomAgent[];
  /** Raw names with `@` that match no agent in this room, deduped, in order. */
  unknown: string[];
  /** Names matching more than one room agent, deduped, in order. */
  ambiguous: string[];
}

/**
 * Characters that make a preceding `@` part of an e-mail/handle instead of a
 * mention. ASCII-only: Chinese prose runs words together (`然后@QA` must fire),
 * whereas `robin@example.com` must not.
 */
const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;

/**
 * Characters that extend a handle *after* a name. `@架构师X` is one unknown
 * handle, not a mention of `架构师`. ASCII-only on purpose: a CJK character is
 * almost always the next word of the sentence (`@架构师看一下`), so stopping at
 * non-ASCII is what makes inline `@` work in Chinese. The accepted cost: in a
 * room declaring only `张三`, `@张三丰` dispatches to `张三`. Longest-name-first
 * removes that hazard for every name the room actually declares.
 */
const HANDLE_CHAR = /[A-Za-z0-9_-]/;

/** Where an unquoted `@token` ends (whitespace and CJK/ASCII punctuation). */
const TOKEN_END = /[\s，。、；：！？,.;:!?/\\|"'“”‘’<>【】[\]{}]/;

const test = (re: RegExp, ch: string | undefined): boolean =>
  ch !== undefined && ch !== "" && re.test(ch);

/** Adjacent code unit, or undefined off the ends. */
const charAt = (s: string, i: number): string | undefined =>
  i < 0 || i >= s.length ? undefined : s[i];

/** Walk forward from `start`, returning the end index of an `@token`. */
const tokenEnd = (content: string, start: number): number => {
  let i = start;
  while (i < content.length) {
    if (test(TOKEN_END, charAt(content, i))) break;
    i += 1;
  }
  return i;
};

/** One claimed `@` and what it resolved to. */
interface Match {
  at: number;
  name: string;
  /** null when the name is ambiguous inside the room. */
  agent: RoomAgent | null;
}

/**
 * Resolve `@mentions` in `content` against the room's agent list.
 *
 * Known names are matched literally (room names carry full-width parentheses
 * and punctuation, e.g. `齐活林（交付总监）`), so one generic regex cannot be
 * correct. Whatever is left that still looks like `@token` is reported as
 * unknown instead of dropped.
 */
export function resolveMentions(content: string, agents: readonly RoomAgent[]): MentionResolution {
  const nameCount = new Map<string, number>();
  for (const agent of agents) nameCount.set(agent.name, (nameCount.get(agent.name) ?? 0) + 1);

  // Longest names first so `@张三丰` cannot be claimed by the shorter `@张三`
  // when the room declares both.
  const byName = [...agents].sort((a, b) => b.name.length - a.name.length);
  const matches: Match[] = [];

  for (const agent of byName) {
    if (!agent.name) continue;
    const needle = `@${agent.name}`;
    let from = 0;
    for (;;) {
      const at = content.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      from = end;
      if (matches.some((m) => m.at === at)) continue;
      // `robin@架构师` — the `@` belongs to the handle before it.
      if (test(ADDRESS_CHAR, charAt(content, at - 1))) continue;
      // `@架构师X` is a longer handle, not this agent.
      if (test(HANDLE_CHAR, charAt(content, end))) continue;
      matches.push({ at, name: agent.name, agent: (nameCount.get(agent.name) ?? 0) > 1 ? null : agent });
    }
  }

  // Outcomes come out in mention order, deduplicated by target (Q35).
  matches.sort((a, b) => a.at - b.at);
  const targets: RoomAgent[] = [];
  const seenTargets = new Set<string>();
  const ambiguous: string[] = [];
  for (const match of matches) {
    if (!match.agent) {
      if (!ambiguous.includes(match.name)) ambiguous.push(match.name);
      continue;
    }
    if (seenTargets.has(match.agent.id)) continue;
    seenTargets.add(match.agent.id);
    targets.push(match.agent);
  }

  const claimed = new Set(matches.map((m) => m.at));
  const unknown: string[] = [];
  // Leftover `@token`s: `@全体`, `@all`, typos, agents from another room.
  for (let at = content.indexOf("@"); at >= 0; at = content.indexOf("@", at + 1)) {
    if (claimed.has(at)) continue;
    if (test(ADDRESS_CHAR, charAt(content, at - 1))) continue;
    const end = tokenEnd(content, at + 1);
    if (end === at + 1) continue;
    const token = content.slice(at + 1, end);
    if (!unknown.includes(token)) unknown.push(token);
  }

  return { targets, unknown, ambiguous };
}
