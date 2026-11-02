/**
 * Pi extension: the `handoff_to` tool — D1 (P8/I10).
 *
 * Pi 1.4.0's built-in tools are `read`/`bash`/`edit`/`write` (plus `grep`/`find`/
 * `ls`): `pi --help` prints exactly that list, and a live RPC session confirms the
 * model has no `handoff_to` to call. Without this file the PRIMARY dispatch path
 * in `packages/orchestrator/src/durable-worker.ts` (`event.toolName !== "handoff_to"`)
 * is unreachable and only the degraded `@name` path ever fires.
 *
 * Loaded by `PiAdapter` through an explicit `--extension <path>` (docs/cli.md:
 * "Explicit -e paths still load"), which is not subject to `--no-extensions` nor to
 * project trust — unlike discovery, which needs either.
 *
 * DELIBERATELY DEPENDENCY-FREE (no `import`, no TypeBox):
 *  1. This file is plain, uncompiled `.js` living OUTSIDE `src/`, so `tsc` never
 *     builds it and `src/adapter.ts` and `dist/adapter.js` resolve the SAME path.
 *  2. It can therefore be imported by a unit test and driven with a fake `pi`, and
 *     the schema it declares is checked against `parseHandoffArgs` without a model.
 *     Verified against the real binary: Pi accepts a literal JSON-Schema object for
 *     `parameters` (it only requires an object — dist/core/extensions/loader.js:236)
 *     and declares it to the model unchanged; the model then calls the tool.
 *
 * DECLARATION, NOT DISPATCH. `execute()` writes no database row, creates no Task
 * and spawns nothing: the platform owns dispatch inside the commit transaction
 * (P6, Q39/Q40), and the authoritative payload is the `args` of the
 * `tool_execution_start` event. The tool result exists only so the model gets a
 * sane acknowledgement and can finish its turn.
 */

/** Must equal `HANDOFF_TOOL_NAME` in @my-team-agents/orchestrator (handoff-intent.ts). */
const HANDOFF_TOOL_NAME = "handoff_to";

/**
 * Schema of a declared handoff. The required pair mirrors `parseHandoffArgs`, which
 * fails a payload with no non-empty `toMemberIds` (its `to` alias stays accepted at
 * the parser) or no `reason`. Unknown extra keys are tolerated on both sides.
 *
 * D5-b: the property is still NAMED `toMemberIds` (the parser's contract, and the
 * worker dispatches on the resolved member id), but it does not require an id. The
 * orchestrator resolves each entry against the room's roster with the same rules the
 * `@name` path uses — `resolveRosterTokens` in `orchestrator/src/mention.ts` — so a
 * name, a role or an id are all addressable, and anything the room does not declare
 * is refused with a system message instead of being dispatched at large.
 *
 * The wording matters as much as the shape: this description used to demand "Exact
 * ids … taken from the roster" while the roster the model was shown contained no id
 * at all. A real acceptance run then went digging through `.template-import.json` with
 * `bash` to guess one. It now says what is actually accepted, in the order the
 * resolver prefers, and points at where the roster lives in the injected prompt.
 */
const HANDOFF_PARAMETERS = {
  type: "object",
  properties: {
    toMemberIds: {
      type: "array",
      items: { type: "string" },
      description:
        "The members taking over, one call may name several. Each entry is copied " +
        "verbatim from the 「# 成员」 list of the group prompt injected into this run: " +
        "a member's name (架构师), its role (交付总监) or its id (agent-...) all resolve. " +
        "Write the token exactly as listed — no spaces added, no paraphrase, no invented " +
        "name. A token this room has no member for, or one two members share, is refused " +
        "and nothing is dispatched; the platform never guesses which 工程师 you meant.",
    },
    reason: {
      type: "string",
      description: "Why the work moves to them. Kept short; it is shown to the room.",
    },
    workPackage: {
      type: "string",
      description:
        "Optional concrete work text for the target, appended to the group context the " +
        "target receives. Omit to use `reason` as the instruction.",
    },
  },
  required: ["toMemberIds", "reason"],
};

export default function (pi) {
  pi.registerTool({
    name: HANDOFF_TOOL_NAME,
    label: "Handoff",
    description:
      "Declare a structured handoff to one or more team members. This registers the " +
      "request for the platform, which dispatches it when this run commits — it does " +
      "not run the target itself. Call it instead of writing an `@name` in prose when " +
      "you know who should take over. Name targets the way the injected 「# 成员」 list " +
      "spells them (name, role or id); the platform validates each one against that " +
      "roster and refuses any it cannot resolve, so a handoff never lands on a member " +
      "this group does not have.",
    parameters: HANDOFF_PARAMETERS,
    // Read-only by construction: the tool cannot mutate the workspace, and the
    // orchestrator already treats `handoff_to` as a safe tool outcome.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: "已登记交接请求，稍后由平台派发" }],
        details: {
          toolCallId,
          declared: {
            toMemberIds: params.toMemberIds,
            reason: params.reason,
            workPackage: params.workPackage ?? null,
          },
          dispatchedBy: "platform",
        },
      };
    },
  });
}
