/**
 * `@name` mention parsing for ChatRoom user messages (I3).
 *
 * Pure: room agents in, resolved targets out. No DB, no time, no queue — every
 * edge case is unit-testable (`mention.test.ts`).
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
 *  - D2: a token that matches no *name* may still match a *role* (`@架构师` →
 *    the agent whose role is 架构师). See the resolution-order note below.
 *  - D4: an `@token` that is code notation (`@ts-ignore`, `@types/node`,
 *    `@media`) is not an unresolved member name; it is dropped from `unknown`
 *    instead of becoming a refusal or a system note. See `isCodeNotation`.
 *  - D5: the same name/role rule answers a structured `handoff_to` token, not just
 *    prose. `resolveRosterTokens` reads the roster (id, then name, then role) with
 *    ONE index shared with `resolveMentions`, so the two dispatch paths of Q34 can
 *    never disagree about who a token names — and a token nobody declares is
 *    `unknown`, which the caller refuses instead of dispatching.
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

/** What one roster token (a `handoff_to` entry) resolved to. */
export interface RosterResolution {
  /** Distinct members in first-token order. */
  targets: RoomAgent[];
  /** Tokens no member of this room answers to, deduped, in order. */
  unknown: string[];
  /** Tokens several members answer to, deduped, in order. */
  ambiguous: string[];
}

/**
 * The ONE notion of "who in this room answers to this string", shared by both
 * ways a colleague can be addressed: `@name` in prose (`resolveMentions`) and a
 * structured `handoff_to` token (`resolveRosterTokens`). Keeping it in one place
 * is what makes the two dispatch paths of Q34 resolve identically — a target the
 * room cannot name is refused by both, and a target it can name dispatches to the
 * same persona whichever path spelled it.
 */
interface RosterIndex {
  /** Members by id. Ids are primary keys, so an id never has two candidates. */
  byId: Map<string, RoomAgent>;
  /** Members by exact `name`, in roster order. */
  byName: Map<string, RoomAgent[]>;
  /** Members by exact non-empty `role`, in roster order. */
  byRole: Map<string, RoomAgent[]>;
  /** Every word a member answers to, lower-cased (`isCodeNotation`'s escape hatch). */
  declared: Set<string>;
}

const groupBy = (agents: readonly RoomAgent[], key: (a: RoomAgent) => string): Map<string, RoomAgent[]> => {
  const out = new Map<string, RoomAgent[]>();
  for (const agent of agents) {
    const k = key(agent);
    if (!k) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(agent);
    else out.set(k, [agent]);
  }
  return out;
};

const rosterIndex = (agents: readonly RoomAgent[]): RosterIndex => {
  const declared = new Set<string>();
  for (const agent of agents) {
    declared.add(agent.name.toLowerCase());
    if (agent.role) declared.add(agent.role.toLowerCase());
  }
  return {
    byId: new Map(agents.map((agent) => [agent.id, agent])),
    byName: groupBy(agents, (agent) => agent.name),
    byRole: groupBy(agents, (agent) => agent.role),
    declared,
  };
};

/** How many room members answer to this exact name/role (0 when nobody does). */
const claimers = (index: Map<string, RoomAgent[]>, token: string): number => index.get(token)?.length ?? 0;


/** The roster's coordinator suffix — `（协调者）` is a tag, not a role. */
const COORDINATOR_TAG = "协调者";

/**
 * Split `名字（角色）（协调者）` into its head and its parenthetical groups, fully
 * nested (either bracket style), refusing anything that is all brackets.
 */
export function splitDisplayForm(token: string): { head: string; groups: string[] } | null {
  const groups: string[] = [];
  let head = token;
  for (;;) {
    const match = /^(.*?)[（(]([^（）()]*)[）)]$/.exec(head);
    if (!match) break;
    head = match[1] ?? "";
    groups.unshift((match[2] ?? "").trim());
  }
  return groups.length > 0 && head !== "" ? { head, groups } : null;
}

/** A parenthetical may be the member's own role, the coordinator tag, or empty. */
const displayTagAgrees = (group: string, agent: RoomAgent): boolean =>
  group === "" || group === COORDINATOR_TAG || group === agent.role;

/**
 * Resolve the tokens a model passed to `handoff_to` against the room's roster
 * (D5). Same rules as `resolveMentions`, same index:
 *  1. an exact agent id always wins — ids are unique by construction;
 *  2. otherwise an exact `name`; if two members share it, `ambiguous`, never a guess;
 *  3. otherwise an exact `role`, and a role two members share is `ambiguous` too.
 * Name-before-role is what keeps `高见远` (a name) meaning 高见远 even when some other
 * member's role reads 高见远 (D2). No fuzzing, no substring, no case folding: a token
 * the room does not declare verbatim is `unknown`, and the caller refuses it —
 * dispatching under a name that merely looks like a persona is a silent
 * mis-dispatch, which is the defect this closes.
 */
export function resolveRosterTokens(
  tokens: readonly string[],
  agents: readonly RoomAgent[],
): RosterResolution {
  const index = rosterIndex(agents);
  const targets: RoomAgent[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const claim = (agent: RoomAgent): void => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    targets.push(agent);
  };
  const report = (list: string[], token: string): void => {
    if (!list.includes(token)) list.push(token);
  };

  for (const raw of tokens) {
    // The roster and the prose path use `@name` notation; a model that carries the
    // `@` over is naming the same person, not a different one.
    const token = raw.startsWith("@") ? raw.slice(1) : raw;
    if (!token) {
      report(unknown, raw);
      continue;
    }
    const byId = index.byId.get(token);
    if (byId) {
      claim(byId);
      continue;
    }
    const named = index.byName.get(token);
    if (named) {
      if (named.length > 1) report(ambiguous, token);
      else claim(named[0]!);
      continue;
    }
    const roled = index.byRole.get(token);
    if (roled) {
      if (roled.length > 1) report(ambiguous, token);
      else claim(roled[0]!);
      continue;
    }
    // The roster line we INJECT reads `- 许清楚（产品经理）｜id: …`, so a model that
    // copies it — the most natural thing to do — used to be refused as "not a member
    // of this room". That was our defect, not the model's: the prompt's own display
    // form has to be a spelling we accept. It resolves only when the head is an
    // exact single name AND every parenthetical agrees with that member (his role, or
    // the coordinator tag), so `许清楚（工程师）` is a contradiction and stays unknown
    // rather than being "close enough".
    const display = splitDisplayForm(token);
    if (display) {
      const heads = index.byName.get(display.head);
      if (heads && heads.length > 1) {
        report(ambiguous, token);
        continue;
      }
      const only = heads?.[0];
      if (only && display.groups.every((group) => displayTagAgrees(group, only))) {
        claim(only);
        continue;
      }
    }
    report(unknown, token);
  }
  return { targets, unknown, ambiguous };
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

/**
 * Characters inside a `@scope/package` path segment. Used only to *extend* a
 * leftover token across `/`, never to decide whether something is a member:
 * `@types/node` must be one token, not `types` + a stray note.
 */
const PACKAGE_CHAR = /[A-Za-z0-9._+-]/;

/** Walk a leftover token through `/`-separated segments (`@ts/check/2`). */
const packageEnd = (content: string, end: number): number => {
  let i = end;
  while (charAt(content, i) === "/" && test(PACKAGE_CHAR, charAt(content, i + 1))) {
    i = tokenEnd(content, i + 1);
  }
  return i;
};

/**
 * D4: code notation that a model writes into prose (`@ts-ignore`, `@media`,
 * `@param`) or into a dependency line (`@types/node`). None of it is a member
 * name, so it must not become `unknown` — on the user path that is a 4xx
 * telling a human their `@ts-ignore` is not a colleague, on the agent path a
 * system message in the shared stream, every single engineering turn.
 *
 * A *closed, lowercase* list, not a heuristic. "Looks like ASCII" cannot work:
 * members are legitimately ASCII (`Robin`, `dev-1`, `QA`), and a heuristic that
 * swallows one of those loses a real dispatch silently — the exact failure this
 * whole file exists to avoid. So nothing here is ever *guessed* to be code;
 * a token has to be spelled exactly like a known tag.
 *
 * Deliberately absent: decorators (`@Component`, `@pytest.fixture`) and any
 * PascalCase form, because capitalised words are also how people name members.
 * Those still produce one note — a false negative costs a message, a false
 * positive costs a task.
 */
const CODE_TAG = new Set([
  // TypeScript / lint / formatter directive comments.
  "ts-ignore", "ts-expect-error", "ts-nocheck", "ts-check", "types",
  "flow", "prettier-ignore", "eslint-disable", "eslint-enable",
  // JSDoc / TSDoc block tags.
  "param", "return", "returns", "throws", "example", "deprecated", "see", "todo",
  "typedef", "template", "override", "enum", "abstract", "access",
  "author", "version", "since", "license",
  // CSS at-rules (the ones a model writes inline in a style block).
  "media", "supports", "import", "apply", "scope", "keyframes", "font-face",
  "charset", "page", "layer", "document", "viewport", "namespace",
]);

const isAscii = (s: string): boolean => !/[^\x20-\x7e]/.test(s);

/**
 * `token` is code notation when it is either scoped-package shaped (`/` inside,
 * ASCII on both sides) or an exact known tag, optionally called like `@media(…`
 * — `(` is not a `TOKEN_END`, so `@media(max-width` arrives whole.
 *
 * `declared` is every name and role in the room, lower-cased. If the room
 * actually declares that word (`an agent named Media`, `role: scope`), the
 * whitelist loses: a token that could be a member is never called code.
 * The name/role passes already claim exact matches, so this is the second net
 * — it catches the case-insensitive near-miss a human would want reported.
 */
const isCodeNotation = (token: string, declared: ReadonlySet<string>): boolean => {
  if (token.includes("/")) return isAscii(token);
  const head = token.split("(")[0] ?? token;
  if (!CODE_TAG.has(head)) return false;
  return !declared.has(head.toLowerCase());
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
 * unknown instead of dropped — the resolver never decides what an unresolved
 * name *means*, because its two callers answer differently on purpose:
 * `postRoomMessage` (user input) turns it into a 4xx, while the agent prose path
 * in `durable-worker.ts` records it and lets the run succeed. Deciding that here
 * would silently give one of the two the other's policy.
 *
 * Resolution order — D2, the rule a real acceptance run forced:
 *  1. **name first.** Every agent's `name` is matched before any `role` is
 *     considered, and a position a name already claimed is never re-claimed. So
 *     `@高见远` resolves to 高见远 alone, even if some other agent's role happens to
 *     read 高见远; and with `A.name = "架构师"` next to `B.role = "架构师"`, `@架构师`
 *     means A. Names are identity, roles are description — identity wins.
 *  2. **role second.** Imported packages name agents by persona (`高见远`, `许清楚`)
 *     while a human remembers the function (`架构师`, `产品经理`). A token that
 *     matches no name may match a `role`; matching `agentId` or `emoji` would turn
 *     an internal identifier into a user interface, so it does not.
 *  3. **a shared role is `ambiguous`, never first-wins.** Five agents in one
 *     package all saying 工程师 is exactly the case the duplicate-NAME rule was
 *     written for; the same reasoning applies verbatim, so the caller gets the
 *     name in `ambiguous` and either refuses (user path) or declines to dispatch
 *     (prose path).
 * This is not "guessing a person from a job title": a role resolves only when it
 * is spelled exactly as the room declares it and only one member declares it.
 * Two candidates, a typo, a longer handle or a different casing = no dispatch.
 */
export function resolveMentions(content: string, agents: readonly RoomAgent[]): MentionResolution {
  const index = rosterIndex(agents);
  const nameCount = (name: string): number => claimers(index.byName, name);
  const roleCount = (role: string): number => claimers(index.byRole, role);
  /** Every word a member answers to, for `isCodeNotation`'s escape hatch. */
  const declared = index.declared;

  // A needle is `@` + the stored string, used verbatim: no trimming, no case
  // folding, no punctuation stripping. Room names and roles are written by an
  // import and compared byte-for-byte, which is what makes `@齐活林（交付总监）`
  // hit and `@架构师 X` (with a space) miss. Role matching reuses this same
  // needle discipline rather than inventing a fuzzier comparison.
  const needleAt = (raw: string): string => `@${raw}`;

  // Longest names first so `@张三丰` cannot be claimed by the shorter `@张三`
  // when the room declares both.
  const byName = [...agents].sort((a, b) => b.name.length - a.name.length);
  const matches: Match[] = [];

  for (const agent of byName) {
    if (!agent.name) continue;
    const needle = needleAt(agent.name);
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
      matches.push({ at, name: agent.name, agent: nameCount(agent.name) > 1 ? null : agent });
    }
  }

  // D2 fallback pass: identical boundaries, but only for positions no name
  // claimed — that single `matches.some` is what makes the name win.
  const byRole = [...agents].sort((a, b) => b.role.length - a.role.length);
  for (const agent of byRole) {
    if (!agent.role) continue;
    const needle = needleAt(agent.role);
    let from = 0;
    for (;;) {
      const at = content.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      from = end;
      if (matches.some((m) => m.at === at)) continue;
      if (test(ADDRESS_CHAR, charAt(content, at - 1))) continue;
      if (test(HANDLE_CHAR, charAt(content, end))) continue;
      matches.push({ at, name: agent.role, agent: roleCount(agent.role) > 1 ? null : agent });
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
    let end = tokenEnd(content, at + 1);
    if (end === at + 1) continue;
    // Only an ASCII head may grow across `/`, so `@types/node` is one token
    // while `@张三/2026` keeps the exact bytes the name path always reported.
    if (isAscii(content.slice(at + 1, end))) end = packageEnd(content, end);
    const token = content.slice(at + 1, end);
    // D4: code notation is not a member name — report neither, on either path.
    if (isCodeNotation(token, declared)) continue;
    if (!unknown.includes(token)) unknown.push(token);
  }

  return { targets, unknown, ambiguous };
}
