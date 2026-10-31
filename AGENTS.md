# AGENTS.md

## Code Canonicality

This file is the canonical entry point for agent work in this repository. Where
`AGENTS.md`, `CONTEXT.md`, and `constraints.yaml` disagree, this file wins on
process, `constraints.yaml` wins on thresholds, and code wins on behavior.

Do not edit rule files silently. `AGENTS.md`, `CONTEXT.md`, `constraints.yaml`,
`justfile`, and `.git-hooks/*` are guarded: a pre-commit hook rejects changes
without `RULE_CHANGE_REASON` set.

## Project Identity

`my-team-agents` — a multi-tenant, company-grade agent-team platform.

- **Core agent loop: Pi** (`@earendil-works/pi-coding-agent`), driven over RPC.
- UI: assistant-ui (`@assistant-ui/react` + `@assistant-ui/react-pi`) — wired in
  `packages/web`; `PiApp` renders through assistant-ui primitives on
  `usePiRuntime`, talking to our own `/api/pi` via `createPiHttpClient`. The UI
  never drives Pi directly; the server is authoritative.
- Monorepo: pnpm workspaces.

V1 goal: stand up the collaboration skeleton modeled on `ref/teamagentx`
(trigger → queue → executor → structured handoff). Everything else is
deliberately deferred — see `## Deferred Modules`.

## Stack & Versions

| Tool | Version | Notes |
|---|---|---|
| Node | >=22.22 | enforced by `engines` |
| pnpm | 11.22.0 | `packageManager` field |
| TypeScript | 5.9.3 | strict, NodeNext |
| Vitest | 3.2.7 | scoped to `packages/**` |
| Pi | 1.4.0 | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`; a live provider needs `~/.pi/agent/models.json` |

## Directory Map

```
packages/runtime-core/   RuntimeAdapter contract + canonical event types
packages/runtime-pi/     Pi RPC adapter (the only full loop)
packages/runtime-cli/    claude/codex/dsh CLI adapters (minimal v1)
packages/domain/         entities + handoff guardrails
packages/orchestrator/   dispatcher loop, structured handoff, stall watchdog,
                         durable SQLite execution store + worker
packages/server/         Fastify API + SSE + standalone worker entrypoints
packages/web/            assistant-ui workbench: usePiRuntime + createPiHttpClient
                         against /api/pi (PiClient projection of the task store)
packages/cost-report/    daily self-assessment from session logs
docs/                    product/architecture/plan docs + Feishu sync manifest
scripts/                 guardrail self-test, doc sync, live pi smoke, I2 import evidence
.git-hooks/              naming + rule-change guard
ref/                     READ-ONLY reference checkouts (teamagentx et al.)
```

`ref/` is git-ignored and must never be edited or imported.

## Development Workflow

```bash
just setup            # install
just check            # build + typecheck + test + verify-cli + guardrails + doc mapping
```

Single surfaces: `just build`, `just typecheck`, `just test`,
`just verify-cli`, `just test-guardrails`, `just verify-docs`.

**Order matters for typecheck only: `build` must precede it.** Packages consume
each other through `dist/*.d.ts`, so a clean checkout fails `TS2307` without a
build. Tests are different: Vitest aliases workspace packages to `src/`, so
`just test-no-build` proves they pass with no `dist/` at all.

Live Pi smoke (`just pi-smoke`) is manual and needs all three prerequisites:
1. `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`
2. A working provider in `~/.pi/agent/models.json` (keep this file private).
3. Network access. Override the default with
   `PI_SMOKE_MODEL=<provider>/<model> just pi-smoke`.
Without these the smoke exits nonzero; do not weaken its assertions to make it
pass, and do not add it to CI unless a model endpoint is available there.

There is no `just lint` — eslint is not installed (readiness gap).
There is no `just dev` — run the API with `pnpm --filter @my-team-agents/server dev`
and the UI with `pnpm --filter @my-team-agents/web dev`.

## Verification Matrix

| Check | Scope | Command | Blocking |
|---|---|---|---|
| Typecheck | all packages | `just typecheck` | yes |
| Tests | all packages | `just test` | yes |
| Build | all packages | `just build` | yes |
| CLI smoke | cost-report | `just verify-cli` | yes |
| Guardrail self-test | guardrail scripts | `just test-guardrails` | yes |
| Doc-sync mapping | `docs/feishu-sync.json` + mapped sources | `just verify-docs` | yes |
| Bitable sync mapping | `docs/feishu-bitable.json` + parsed sources | `just verify-bitable` | yes |
| Sync-layer unit tests | `scripts/*.test.mjs` | `just test-scripts` | yes |
| Package resolution | every workspace package | `just verify-packages` | yes |
| Tests without any build | all packages | `just test-no-build` | yes |
| Real Pi end-to-end | runtime-pi + live model | `just pi-smoke` | no (needs pi + network) |
| Template import evidence | `packages/orchestrator/src/template-import.ts` | `just verify-import` | no (needs local `ref/` zips) |

Every command above resolves to a real `justfile` target. Do not add a row that
does not have one.

## Important Development Notes

- **Rule-file changes need `RULE_CHANGE_REASON`.** It is read from the
  environment, so an `export`ed value persists across later commits and silently
  disables the check. Verify with `env -u RULE_CHANGE_REASON` when testing.
- **Build before typecheck**, but **not before tests**. Packages consume each
  other via `dist/*.d.ts`, so a fresh clone fails `TS2307` unless built first.
  Tests instead resolve workspace packages to `src/` through the aliases in
  `vitest.config.ts`, so `pnpm test` is self-sufficient. New workspace packages
  need both an `exports` field and a src alias; `just verify-packages` fails if
  either is missing, and `just test-no-build` proves tests pass with no dist at
  all. Never "fix" a test by building first — that hides the dependency.
- **Pi trust**: RPC mode cannot show the interactive trust prompt, so
  `PiAdapter` always passes explicit `--approve`/`--no-approve`. Trust does not
  constrain tool access — isolation comes from the process/container.
- **Pi usage**: per-message `usage` is what makes cost attribution possible;
  `get_session_stats` is the session-level fallback.
- **`agentDir` is per-supervisor, not per-thread**, upstream in react-pi. The
  `agentDir` seam exists in `RunSpec` and is intentionally inert in v1.
- **dsh is a cordis profile launcher**, not a coding-agent runtime. It is
  supported as a CLI adapter only.
- **Unknown events are never dropped**: unmapped upstream names surface as
  `type: "unknown"` with `rawType` preserved. Exception: RPC control frames
  (`response`, `extension_ui_request`) are protocol records, not session
  activity, and are filtered before canonicalization (docs/rpc.md).
- **Pi session resume**: a session persists by default. `--session-id` alone
  does NOT load history; `--session <path>` does, so `RunSpec.session.sessionPath`
  is what resume uses. Resume continues the conversation only — unknown tool
  side effects still require human confirmation (Q18). `just pi-smoke` proves
  both completion semantics and resume-with-memory against a live model.

## Documentation Sync

`AGENTS.md`, `CONTEXT.md` and every file under `docs/` are mirrored one-way to
the Feishu wiki space `my-team-agents` (space_id `7701231058624187646`):

```bash
just verify-docs      # offline: mapping + source files (part of just check)
just sync-docs        # overwrite the Feishu copy of every mapped doc
just sync-docs docs/architecture.md   # sync one doc
```

- Mapping lives in `docs/feishu-sync.json` (source -> node_token/document_id).
  A new doc requires a manifest entry before it can sync; `just verify-docs`
  fails if a required source is unmapped or a mapped source is missing.
- **The repo is the single source of truth.** Edit the repo, then sync; do not
  edit Feishu copies or record decisions only in Feishu comments.
- `just sync-docs` is intentionally NOT in CI: it needs the local `lark-cli`
  user credential. The blocking CI surface is the offline mapping check.
- Any change to a synced document must be accompanied by a `just sync-docs`
  run in the same task; report the command's exit code honestly.
- Feishu node titles follow each document's first `# ` heading — `overwrite`
  sets the docx title. Keep that heading stable if you need a stable label.

### Progress tracker (Bitable)

Project state is also mirrored into a Feishu Bitable under the same wiki space,
so progress is live without reading Markdown:

```bash
just verify-bitable   # offline: parse docs + validate docs/feishu-bitable.json
just test-scripts     # unit tests for the parser/upsert layer
just sync-bitable     # upsert phases / milestones / risks / changelog
just sync-all         # docs + Bitable in one go (the usual post-change command)
```

- Tables and fields are declared in `docs/feishu-bitable.json`; rows come from
  `docs/project-plan.md` (阶段表、里程碑、风险登记、延后清单) and `CONTEXT.md`
  (决策日志). `scripts/feishu-bitable.mjs` is the pure layer,
  `scripts/sync-feishu-bitable.mjs` the lark-cli driver.
- Upsert is keyed on stable business keys (阶段号 / 里程碑号 / 条目主键 / 风险 / 项).
  Rows are never deleted: a row that leaves the docs is flagged `仓库内=已移除`,
  and `进展记录` is append-only, deduplicated by content hash.
  So human-added columns, rows and record ids survive every sync.
- Same discipline as docs: the Bitable is a **projection**. Do not hand-maintain
  derived columns in Feishu; edit `docs/project-plan.md` and run `just sync-bitable`.
- `base_token` starts as `PENDING_FIRST_PROVISION`. The first `just sync-bitable`
  in a terminal that can reach the Keychain creates the node, writes the real
  tokens back into `docs/feishu-bitable.json`, and that rewrite must be committed.

## Conventions

- TypeScript strict; `noUncheckedIndexedAccess` is on — index access needs guards.
- Extension seams are declared but inert: a field may exist without v1 behavior.
  Mark them with a `Seam:` comment explaining what future phase fills them in.
- Attribution keys (`tenant`/`project`/`member`) flow through every cost row.

## Code Review Self-Check

- Does the change add a gate that cannot pass? (no phantom enforcement)
- Does it drop an unknown event instead of surfacing it?
- Does it edit `ref/`?
- Does it introduce a `_v2`/`.bak` artifact?
- Does it change a rule file without `RULE_CHANGE_REASON`?

## Critical Paths

- `packages/runtime-core/src/events.ts` — canonical event names; changing these
  breaks every adapter at once.
- `packages/runtime-pi/src/adapter.ts` — JSONL framing; partial lines must buffer.
- `packages/orchestrator/src/dispatcher.ts` — handoffs dispatch only after
  settle, and only within guardrails. A runtime that throws on `start()` must
  degrade to `failed`, never propagate.
- `packages/orchestrator/src/handoff-intent.ts` — handoff intent is declared via
  the `handoff_to` tool, never scraped from prose.
- `packages/domain/src/handoff.ts` — guardrails must be deterministic, never
  model-dependent.
- `packages/cost-report/src/parse.ts` — `since` cursor makes daily runs idempotent.

## Agent Operating Rules

- **Project owns the workspace.** A group chat is a view; rebuilding a group
  never touches the workspace.
- **Agents bind to one project.** Reporting roles (PMO/HR) may span projects.
- **Handoff is structured**, never parsed from prose.
- **Deferred means deferred**: do not implement promotion, capability packages,
  or a 5-layer ledger in v1. Keep their seams stable instead.
- Report verification honestly: run the command, report the exit code.

## Enforcement Index

Rows are `rule | where | checked by | level`. A `block` row must name a runnable
checker; nothing here is advisory only.

| Rule | Where | Checked by | Level |
|---|---|---|---|
| Types compile | all packages | `just typecheck` | block |
| Tests pass | `packages/cost-report`, `packages/domain`, `packages/runtime-cli` | `just test` | block |
| Packages build | all packages | `just build` | block |
| CLI is executable | `packages/cost-report` | `just verify-cli` | block |
| Guardrails reject bad artifacts | `scripts/test-guardrails.sh` | `just test-guardrails` | block |
| No forbidden artifact names | staged files | `.git-hooks/check-naming.sh` (pre-commit) | block |
| Rule-file changes carry a reason | `AGENTS.md`, `CONTEXT.md`, `constraints.yaml`, `justfile`, `.git-hooks/check-naming.sh` | `.git-hooks/check-naming.sh` (pre-commit) | block |
| Full matrix green on push/PR | repo | `.github/workflows/ci.yml` (CI) | gate |
| Test scope excludes `ref/` | `vitest.config.ts` | `just test` | block |
| Doc-sync mapping is complete | `docs/feishu-sync.json` + mapped sources | `just verify-docs` | block |
| Bitable sync mapping is complete | `docs/feishu-bitable.json` + parsed docs | `just verify-bitable` | block |
| Sync layer tests pass | `scripts/*.test.mjs` | `just test-scripts` | block |
| Template package imports with rollback proven | `packages/orchestrator/src/template-import.ts` + `ref/teamagentx-templates/*.zip` | `just verify-import` | gate |

## Deferred Modules

| Module | Status |
|---|---|
| Capability packages | deferred; v1 scripture = LLM wiki + RAG |
| Promotion / grading / HR review | deferred; v1 = daily self-assessment |
| 5-layer cost ledger | deferred; v1 = session-log report |
| assistant-ui integration | **done in P7a** — `packages/web` on `usePiRuntime`; not deferred. Deferred part is team auth/tenancy (P7b) |
