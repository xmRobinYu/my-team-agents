# CONTEXT.md

Project context, vocabulary, and the decision log. Decisions here are
**append-only**: later entries amend earlier ones and never overwrite them.

## Vocabulary

| Term | Meaning | Status |
|---|---|---|
| Project | Owns one workspace (`.pi/`, AGENTS.md, git repo) | settled |
| Group | A collaboration **view** over a project | settled |
| ChatRoom | The **entity** that holds a shared message stream, its rules, and its own set of agents. A Group is only a view; a ChatRoom carries messages | settled (Q33) |
| Agent persona | One agent's identity: its own agentDir (cwd + skills + AGENTS.md) plus role prompt | settled (Q29) |
| Round | One agent trigger (by `@` or by tool). The round cap bounds agent-to-agent chatter | settled (Q30) |
| Coordinator | The agent designated by a template package to wrap up when the round cap is hit | settled (Q30) |
| Team template | A package (zip) importing a whole ChatRoom: room name + rules + N agents + their skills | settled (Q28) |
| Member | Human or agent; agents bind to one project | settled |
| Reporting role | PMO / group manager / HR; may span projects | settled |
| Handoff | Structured agent-to-agent dispatch, bounded by guardrails | settled |
| Task | A unit of work owned by a project and assigned to a member | settled |
| Attempt | One execution of a Task; retries create new Attempts without erasing history | settled |
| Recovery | Task-level continuation after worker loss; side effects are not guaranteed exactly-once | settled |
| 藏经阁 (Scripture) | Org knowledge base; v1 = LLM wiki + RAG | v1 scoped |
| workbuddy | unresolved | TBD |
| jev | unresolved | TBD |
| omp | unresolved | TBD |

## Decision Log

Entries are append-only. Each records question, answer, and reason.

### Q1 — Strictness
**A**: L3 关键型. **R**: strict limits + anti-stub + staged rollout + guardrails
on key modules.
**Gap**: coverage tooling and anti-stub automation declared as gaps, not
fabricated thresholds.

### Q2 — Domain skeleton
**A**: Project owns the workspace; group chat is only a view; employee agents
are fixed to one project; reporting roles are cross-project.
**R**: user correction — "群里里面的机器人大部分始终属于这个项目，除了汇报人员可能属于多个项目".

### Q3 — Runtime adapters
**A**: three first-class adapters (Pi / claude cli / codex cli).
**Amended (later)**: v1 = **CLI-only** for claude/codex/dsh; Pi is the only full
loop. Event-stream parity intentionally dropped.
**R**: user — "claude，codex，dsh 初期可以先支持cli接入，先快速实现".

### Q4 — dsh
**A**: **not** a coding-agent runtime. It is a cordis plugin/profile launcher
(config injection). Supported as a CLI adapter only.
**R**: verified `dsh --help`; `@nanmicoder/dsh-agent-teams` is skipped as
incompatible with installed dsh 0.2.0-rc.2.

### Q5/Q6 — Promotion & capability packages
**A**: **deferred**. **R**: user — "能力包仓库 和晋升体系可以往后放一放".
Seams preserved (`Member.grade`, `Project.agentDir`).

### Q7 — 藏经阁
**A**: v1 = LLM wiki + RAG. **R**: user amendment; package-repo form deferred.

### Q8 — Multi-tenant isolation
**A**: extend react-pi `createThread` with per-thread `agentDir` (patch + upstream PR).
**R**: react-pi fixes `agentDir` at supervisor construction; Pi keeps
skills/auth/AGENTS.md in the agent dir, so per-tenant isolation needs it.
**Status**: seam declared, not implemented in v1.

### Q9 — Cost attribution
**A**: five-layer (tenant→project→member→session→model).
**Amended**: v1 = daily report from session logs. **R**: user redirected scope.

### Q10 — Rule-file guard
**A**: L3 + pre-commit hook guarding rule-file changes. **R**: governance edits
must never be silent.

### Q11 — Conditional modules
**A**: decision records live in this file (no separate ADR lifecycle); no
standalone doc-discipline or incident modules in v1; DDD boundaries expressed
via package layout; TDD required for critical isolation logic (agentDir/workspace
resolution, cost attribution).

### Q12 — Evaluation scope
**A**: daily self-assessment + daily report only. **R**: user — "评估体系初期可以简单每日用一个自评估技能跑跑session日志记录".

### Q13 — v1 goal
**A**: replicate the teamagentx basic skeleton first; simplify or defer the rest,
but leave extension seams. **R**: user — "第一期的主要目标是仿照teamagentx把基础架子搭建起来" +
"只是在实现过程中需要预留未来拓展的口子".

### Q14 — Handoff intent must be declared, not parsed
**A**: agents declare handoffs through a `handoff_to` tool call; prose is never
scraped for `@mentions`.
**R**: teamagentx replaced regex/prose mention parsing with `mention_agents`
structured handoff precisely because prose is unreliable — a model writing
"@bob look at this" in a sentence is not dispatching.

### Q15 — Dispatch timing
**A**: handoff dispatch happens only AFTER the run settles, never mid-stream.
**R**: prevents a still-emitting run from fanning out without bound; bounds are
enforced in code, independent of model behavior.

### Q16 — Queue persistence
**A**: v1 queue is in-memory FIFO; a crash loses queued work. **R**: acknowledged
v1 limit, not an oversight — persistence is the next seam.
**Gap**: no durability, no retry across process restarts.

### Q17 — Documentation synchronization
**A**: repo Markdown is mirrored one-way to the Feishu wiki space
`my-team-agents` (space_id `7701231058624187646`) via `just sync-docs`; the
offline mapping check `just verify-docs` is part of `just check`.
**R**: user — "文档有更新都需要同步一份的飞书上面，可以把这个写入agents.md里面".
**Why one-way**: two-way editing turns the Feishu copy into a second source of
truth that silently diverges from the repo. Overwrite + read-back keeps the repo
authoritative and makes the sync idempotent.
**Gap**: `just sync-docs` needs local `lark-cli` user credentials, so it cannot
run in CI; only the offline mapping check is CI-enforceable.

### Q18 — P6 crash-recovery semantics
**A**: task-level recovery. Preserve event, handoff-chain and cost history.
Resume the original session when the runtime supports it; otherwise create a new
Attempt. If a high-risk tool outcome is unknown, do not auto-replay: require
human review. External side effects are not promised to be exactly-once.
**R**: user selected option A.
**Terminology**: `Attempt` is the domain term for one execution try; `Run` stays
only in runtime API names.
**Gap**: the current Pi adapter always starts with `--no-session`; session
identity/checkpoint persistence and resume support are P6 work, not current
capability.

### Q19 — P6/P7 execution infrastructure
**A**: SQLite; separate API and Worker processes; one active Worker per project
workspace; the server is the sole authority for production task state.
**R**: user selected A for Q2/Q3/Q4.
- Claim and commit must use conditional atomic updates plus a fencing token, not
  a two-step `SELECT` then `UPDATE`.
- Single active Worker means no concurrent execution in one project workspace;
  it is not a claim that SQLite supports distributed multi-Worker scheduling.
- assistant-ui renders interaction; Task/Attempt/Event APIs own production
  lifecycle and history. react-pi does not own the production queue.
**Seam**: move to PostgreSQL before enabling distributed multi-Worker execution.

### Q20 — Recovery safety and handoff consistency
**A**: conservative tool recovery, structured recovery input, and transactional
handoff outbox. **R**: user selected A for Q5/Q6/Q7.
- Only tools explicitly known to be read-only or idempotent may recover
  automatically. Other tools with unknown outcomes put the Task in `blocked`;
  the user chooses whether the effect completed, should retry, or is cancelled.
- A new Attempt receives an immutable recovery snapshot: original request,
  progress summary, last assistant response, unfinished work and known tool
  outcomes. It is not a replay of the entire event stream.
- The Attempt result, Task status, handoff records and outbox entries commit in
  one SQLite transaction. Runtime processes never start inside that transaction.
  A Worker claims outbox work afterward.
- A child Task is deduplicated by source `toolCallId` and target `memberId`;
  handoffs remain post-settle only.
**Cancellation fact**: current runtime cancellation is cooperative. Lease expiry
alone does not prove the old Attempt has terminated; late writes must be fenced.

### Q21 — Retry, chain cancellation and timeouts
**A**: at most 3 Attempts per Task with backoff and jitter; cancelling a parent
cancels its unfinished handoff descendants; idle timeout 120s, lease 30s with a
10s renewal interval and a 30s post-cancel grace period, all configurable.
**R**: user instructed to continue with the recommended options after selecting
Q5–Q7 as A.
- Retry count is persisted per Task and does not reset on Worker restart.
- Exhausted attempts appear in the Dead Letter operational view, not a separate
  task type.
- Cancelling a parent blocks queued descendants, closes blocked descendants and
  cooperatively cancels active Attempts. The UI reports the affected count.
- Cancellation is a chain request, not a guarantee of instant external effect.
- An expired lease isolates the old Attempt; old fencing-token writes are
  rejected without waiting indefinitely for the process to terminate.
**Terminology**: an Attempt belongs to exactly one Task. A handoff creates a new
child Task, not another Attempt of its parent Task.

### Q22 — Handoff input, realtime transport and attachments
**A**: explicit handoff work package; SSE for server-to-browser events and HTTP
for operations; text, image and workspace-file-reference inputs, without general
file upload. **R**: user selected A for Q11/Q13/Q14.
- A handoff work package contains a goal, reason, concrete instructions,
  necessary context, artifact references and constraints. It is persisted as the
  input of a child Task, not as an inherited full parent transcript.
- Event streams carry monotonic sequence numbers and support reconnect replay.
- General file upload is deferred; it requires separate storage, type checks and
  access-control decisions.
**Open**: Q12 remains undecided. The user answered "A/B"; local-only validation
and authenticated team deployment are different release boundaries and must not
be silently combined.
**Amended by Q23**: staged P7a → P7b release.

### Q23 — P7 release boundary
**A**: staged P7a → P7b delivery. **R**: user selected A→B.
- P7a is local/controlled-environment acceptance only. The API binds to
  loopback and the UI explicitly says development mode. It does not claim login,
  authorization or tenant isolation.
- P7b adds authentication, tenant/project access checks, SSE authentication,
  operation authorization and audit before team exposure.
- P7b is a release gate: P7a must not be exposed to a shared or team environment
  merely because the UI works.

### Q24 — P6/P7a implementation boundary
**A**: durable execution landed as SQLite `ExecutionStore` plus a separate API and
Worker process. **R**: implements Q18–Q23 decisions.
- Task/Attempt/Event/Usage/Outbox are persisted; fence tokens reject late writes.
- Session resume is wired end-to-end: the Pi adapter reports its `sessionFile`
  (from RPC `get_state`), the store persists it per Task under the Attempt's
  fencing token, and a retry Attempt resumes it with `--session <path>` when
  `sessionResume` is advertised and the file still exists.
- When resume is unavailable (CLI adapters, missing file, first Attempt),
  recovery falls back to a new Attempt built from the deterministic snapshot.
- `busy_timeout` is required: separate processes hit SQLITE_BUSY without it.
**Bound**: resume continues the *conversation*, not tool side effects. A crashed
run whose file writes are unknown still requires human confirmation (Q18).

### Q25 — Development-only mock runtime
**A**: a deterministic mock adapter exists for local verification. **R**: allows
queue, retry, handoff and UI verification without the `pi` binary.
- It never calls a model and never edits files; the UI must not present it as an
  agent result.
- `MTA_RUNTIME=mock` selects it; production mode uses Pi or CLI adapters.
**Gap**: mock success is not evidence that Pi integration works.

### Q26 — Real Pi smoke findings (2026-10-28)
**A**: installed `@earendil-works/pi-coding-agent` 1.4.0, configured custom
provider `airouter` (OpenAI-compatible), ran live end-to-end tests.
**Findings that changed code**:
1. **`--no-session` was unconditional**: `PiAdapter.start()` always passed
   `--no-session` when no `sessionId`, so the first run never persisted a
   session and resume was impossible. Fixed: default now persists a new session;
   only `resume: false` is ephemeral.
2. **`--session-id` does not load history**: it only selects the session file;
   the model starts with empty context. `--session <path>` loads the full
   history. Fixed: adapter now prefers `sessionPath` and uses `--session`.
3. **RPC control frames leaked as `unknown` events**: `response` and
   `extension_ui_request` are protocol records, not session activity. Fixed:
   they are filtered before canonicalization.
**Verified**: `agent_settled` completion semantics, session resume with memory
(model recalled a token taught in run 1), usage attribution.
**New gate**: `just pi-smoke` runs live smoke (not in `check` — needs pi +
network + working model).

### Q27 — react-pi integration approach (2026-10-29)
**A**: full replacement of the hand-written workbench with `usePiRuntime`.
**R**: user chose full replacement over panel-only or parallel-page options.
**Architecture**:
- `PiClient` is transport-agnostic, so the UI talks to OUR server via
  `createPiHttpClient({ baseUrl: "/api/pi" })` — it never drives Pi directly.
- We did NOT use `createPiNodeClient`: that supervisor owns the Pi process and
  would bypass the durable queue/lease/retry/recovery (P6). Instead a projection
  layer maps Task==Thread and translates persisted CanonicalEvents into the
  PiClient event contract (`packages/server/src/pi-thread.ts`, `pi-routes.ts`).
- react-pi creates an EMPTY thread (initialize) then sends the first message.
  A placeholder Task is parked (availableAt far-future) and activated on the
  first real prompt via `store.activatePlaceholder`; follow-ups map to durable
  retry. P6 semantics are preserved.
- Terminal tasks emit `agent_end`/`agent_settled` in the SSE stream so the UI
  leaves the running state even when a runtime (mock) never emits them.
- The detail panel keeps reading `/api/tasks/:id` because attempts, usage,
  handoffs and chain are P6 evidence the PiClient contract does not model.
**Removed**: App.tsx, TaskThread, TaskListPanel, NewTaskPanel, ConversationStore,
chat/mapping(+test), useWorkbenchData — all superseded by usePiRuntime.
**Verified**: 9 projection/route tests, live reducer accepts translated frames,
end-to-end via the real react-pi HTTP client (create → send → SSE → idle,
underlying task `succeeded`).

### Q28 — V1 多 agent 群聊与团队模板 (2026-10-30)
**A**: replicate teamagentx's group chat under OUR durable kernel, importing
whole-team template packages. **R**: user answered Q28.1–Q28.4.
- **Template = whole-team snapshot, not a role.** A teamagentx template zip is
  `manifest.json` + `snapshot.json`, and snapshot carries `room` (name, rules)
  + `agents[]` (each with prompt, model, thinking mode, capabilities) +
  `categories` + `cronTasks`. Importing one package produces a ready group.
  (Verified: `全栈软件研发` = room + 5 agents; 32 packages available.)
- **Collaboration semantics are ported, the backend is not.** teamagentx runs
  Fastify + Socket.io + Prisma with loop/round guards in an **in-memory Map**
  (its spec AC3.4 accepts losing state on restart). We keep the durable
  ExecutionStore and implement mention-trigger, round cap, loop detection and
  termination on top of it — group state, rounds and termination persist.
- **The user is a group member** and sees the shared message stream, as in
  teamagentx; `@name` selects who replies.
- **Scope**: build the import mechanism and validate a small number of packages
  first, not all 32.
**Open (resolved in Q29)**: how a multi-agent group maps onto react-pi threads.

### Q29 — Group/thread mapping, persona isolation, flow control (2026-10-30)
**A**: one group = one thread with authored messages; each agent gets its own
agentDir; all three flow guards land, persisted. **R**: user answered Q29.1–Q29.3.
- **Group == one thread.** The shared stream is one PiClient thread; each
  message carries its author (user or a specific agent). This is what makes the
  UI look like teamagentx. Agent replies are projected into that thread.
- **Persona = own agentDir** (cwd + skills + AGENTS.md), not just a prompt swap.
  Sessions are isolated per agent too.
- **All three guards** — loop detection, round cap (default 5), `[讨论结束]`
  termination — but state lives in SQLite, not in memory as upstream does.
- **UI scope for V1**: three-column layout (conversation list / group chat with
  multi-agent avatars + `@` input / member panel). Task panels come later.

### Q30 — Context scope, round counting, coordinator (2026-10-30)
**A**: full group history is injected; a round is one agent trigger; the
coordinator is designated by the template package. **R**: user answered Q30.1–Q30.3.
- **Context**: when an agent is triggered it receives the full group
  conversation, including other agents' messages, plus its own persona. This is
  what makes it a group rather than parallel private chats.
- **Round**: one agent trigger (by `@` or by tool) counts as one round; hitting
  the cap forces the coordinator to wrap up (matches upstream AC2.1).
- **Coordinator**: designated inside the template package (upstream uses
  `defaultAgentId`); e.g. `齐活林（交付总监）` in `全栈软件研发`.
**Tension resolved in Q31.**

### Q31 — History injection, concurrency, out-of-scope template parts (2026-10-30)
**A**: no session resume; agents in a group run serially; skip cronTasks and
categories. **R**: user answered Q31.1–Q31.3.
- **No resume.** Every trigger starts a clean Pi process and injects the group
  history. No double-counting, and it *simplifies* recovery: a crashed trigger
  is replayed by re-injecting the same history, so no Pi-internal state has to
  be restored. This narrows Q18's "resume the original session" for group chat:
  session resume stays a Pi-adapter capability but the group path does not use it.
- **Serial per group.** One agent runs at a time within a group; a trigger for a
  second agent waits. Keeps the shared stream readable and bounds cost spikes.
- **Not migrated in V1**: `cronTasks` and `categories` from template packages.

### Q32 — Skills, deliverable form, acceptance gate (2026-10-30)
**A**: full skills management UI; deliver a PRD plus updated project plan;
acceptance = one real template package + `@` + guards. **R**: user answered Q32.1–Q32.3.
- **Skills**: ship skill management UI, not just skill injection. This widens V1
  beyond the three-column chat scope agreed in Q29 by at least one more page;
  confirmed by the user in Q33 as in-scope.
- **Deliverable**: a PRD under `docs/prd/` with user stories and acceptance
  criteria, plus an updated `docs/project-plan.md`.
- **Acceptance gate**: import a real template package, `@mention` an agent and
  get an authored reply, and show the guards firing — with a real model, not mock.

### Q33 — ChatRoom vs Group; skills UI scope (2026-10-30)
**A**: introduce `ChatRoom` as the entity that carries messages; `Group` stays a
view. Full skills management UI ships in V1. **R**: user answered Q33.1–Q33.2.
- **Why a new term**: the glossary defined `Group` as a *view* over a project.
  A view cannot hold a message stream, members, rules or its own agent set.
  Conflating them would have forced `Group` to mean two different things.
- **Skills UI** is in V1 scope despite widening the UI surface agreed in Q29.

### Q34 — Trigger mode, ChatRoom ownership, agent-to-agent dispatch (2026-10-30)
**A**: auto mode (agents can trigger agents); a ChatRoom belongs to a Project and
shares its workspace; both dispatch paths are recognised with `handoff_to` first.
**R**: user answered Q34.1–Q34.3.
- **Auto mode**: agent messages can trigger other agents, so loop detection and
  the round cap are genuinely required, not defensive decoration.
- **ChatRoom belongs to a Project**; imported agents become that project's
  members and share the workspace (consistent with "agents bind to one project").
- **Amends Q14**: agent-to-agent dispatch recognises both the structured
  `handoff_to` tool and `@name` text in agent messages, with `handoff_to` taking
  precedence. Q14's "prose is never scraped" is therefore narrowed — it still
  holds for the authoritative path, but text mentions are a secondary trigger.

### Q35 — Dispatch dedup (2026-10-30)
**A**: both paths are parsed and results are deduplicated **by target agent**.
**R**: user answered Q35.1.
- A target is enqueued at most once per source message, so a message that names
  the same agent via `handoff_to` and `@` triggers it once, not twice.
- Distinct targets from the two paths are both honoured.

**Amends Q8**: the claim that per-agent `agentDir` is blocked upstream applies
only to react-pi's `createPiNodeClient` supervisor, which we never use. Our
`PiAdapter` spawns `pi` itself (`cwd: spec.workspacePath`), so agentDir, skills
and session dir are ours to set per run. `RunSpec.agentDir` exists
(`runtime-core/src/adapter.ts:66`) but its comment still says "blocked upstream"
— that comment is wrong for our architecture and must be corrected when P8
lands. Verified Pi CLI flags: `--skill`, `--append-system-prompt`,
`--session-dir`, `--extension`, `--no-context-files`.

### Q36 — Feishu Bitable as a projection of the plan (2026-10-31)
**A**: project progress is mirrored into a Bitable **under the wiki space**, derived
from the repo, never hand-maintained. **R**: user wants live progress management
without leaving Feishu, while keeping the repo as the single source of truth (Q17).
- Node is created in-space: `lark-cli wiki +node-create --obj-type bitable`, so the
  tracker sits in the wiki tree rather than as a stray Drive doc.
- Tables: 项目阶段 / 里程碑 / 里程碑条目 / 风险登记 / 延后清单 / 项目总览 / 进展记录.
  Schema is committed as `docs/feishu-bitable.json` (JSON, not Markdown, so
  `just verify-docs` does not claim it).
- **Upsert by business key, never delete-and-rebuild**: 阶段号 / 里程碑号 /
  条目主键 (e.g. `M3.5#4`) / 风险 / 项. Rebuilding would drop user-added columns,
  rows and every `record_id`.
- Rows that leave the docs are flagged `仓库内=已移除`; a run that would flag ≥3 rows
  **and** over half a table is refused unless re-run with `--allow-mass-removal`.
  A renamed doc section must not silently read as "the project cancelled everything".
- `进展记录` is append-only, keyed by a content hash: unchanged repo ⇒ zero writes,
  so "sync every change" costs nothing when nothing changed.
- Status vocabulary is fixed select options derived from the doc markers; anything
  the parser cannot classify becomes `未标注` with `状态原文` preserved. Absence of a
  marker is never rendered as completion.
- The parser adapts to the docs, not the reverse: an expected table header or section
  that disappears fails the sync loudly.
- Offline gate: `just verify-bitable` + `just test-scripts` (node:test, because
  vitest is scoped to `packages/**`). `just sync-bitable` is manual like
  `just sync-docs` — it needs the local lark-cli Keychain credential.

### Q37 — Retry backoff corrected (2026-10-31)
**A**: Q21's "backoff and jitter" is now implemented for real: one shared
`retryDelay(batchAttempts, rng)` (`orchestrator/execution-store.ts`) yields
`5_000 x [0.8, 1.2]` after the first Attempt and `25_000 x [0.8, 1.2]` after
later ones, i.e. a 4s–6s / 20s–30s bounded window, and **both** re-arm paths
call it. **R**: audit found the crash/lease-expiry path had no throttle at all.
- `finishFailure` already backed off (fixed 5s→25s, no jitter). `recoverAttempt`
  wrote `available_at = now`, so a Task whose Worker crashed was re-claimed on
  the next 250ms poll: a crash loop burned runtime and process slots with zero
  throttling, and it disagreed with the failure path for the same Task.
- Jitter is bounded (±20% of base) and the random source is injectable
  (`new ExecutionStore(file, { rng })`), so tests either assert exact values with
  a pinned `rng` or assert the interval. Determinism was kept by injecting the
  source, **not** by disabling jitter.
- Grace period, restated: Q21's "30s post-cancel grace period" is **not** an
  independent configurable value. Cancellation is `requestCancelChain` setting
  `cancel_requested=1` + `running`→`cancelling`, then the Worker watchdog polls
  the chain every ≤1s and calls `handle.cancel("abort")`
  (`durable-worker.ts:137-140`). If the runtime never terminates, the **only**
  backstop is lease expiry, after which `recoverExpired` orphans the Attempt —
  so the 30s lease effectively doubles as the grace window. Do not assume a
  separate timer exists.
- Still true from Q21: 3 Attempts per batch, 120s idle timeout, 30s lease with a
  10s renewal, persisted attempt count, dead-letter as an operational view.
- Gates: `recovery.test.ts` now asserts the takeover window and that a re-claim
  inside it is refused; `execution-store.test.ts` pins `rng` for the clock-walking
  case and asserts the interval for the jitter case, plus a direct `retryDelay`
  unit test. These fail if either path drops its backoff.

### Q38 — I3: agentDir takes effect as cwd, room serialisation is a queue property (2026-11-01)
**A**: a mention becomes one Task per target, and the persona dir reaches Pi as the
child `cwd`; tasks sharing a `groupId` are serialised by `claimNext` itself.
**R**: upstream Pi offers no other mechanism, and a serial rule that only held
because one Worker process happens to tick would be a false guarantee.
- `agentDir` maps to the child `cwd`. The Pi CLI has no `--agent-dir`-style config
  directory flag; the official `docs/cli.md` states that the working directory also
  controls project configuration, resource discovery and session grouping. So a
  persona directory can only take effect through cwd.
- **Cost, accepted deliberately**: a run whose cwd is an `agentDir` **cannot see the
  project workspace**. Not an omission to fix later — it is the price of persona
  isolation, which is why `RunSpec.workspacePath` stays separate and is still
  recorded on the Task (attribution, and the fallback when no `agentDir` exists).
- Capability declarations: `PiAdapter.capabilities.agentDirPerRun` is `true`;
  `runtime-cli` and the server mock adapter keep `false`, because they genuinely
  ignore the field. The declaration is behaviour, not aspiration.
- Same-room serialisation: `groupId = roomId`, and the exclusion lives inside the
  `claimNext` SELECT — `NOT EXISTS` a `leased`/`running` Attempt with an
  unexpired lease for that group — in the same `BEGIN IMMEDIATE` as the Attempt
  INSERT. That makes it a property of the queue, so it holds across multiple
  Worker processes, not just one ticking worker. An expired lease stops blocking,
  so a crashed holder cannot lock a room forever.
- Transaction: `ExecutionStore.tx` was promoted to a public re-entrant
  `transaction()`; a nested call joins the open transaction instead of starting a
  second one (SQLite forbids that). This is what lets "append the message + create
  N Tasks" commit as one unit, so a refused or failed trigger leaves neither a
  message nobody answers nor a Task with no message behind it. `postRoomMessage`
  asserts `RoomStore` and `ExecutionStore` share one `DatabaseSync` handle — the
  wiring `buildApp` already relies on.
- I3 is trigger-only: a message without `@` is rejected 4xx rather than stored as
  idle chat, because a stored message no one answers is the same silent failure
  the 4xx exists to avoid. `ambiguous` / `unknown` mentions answer with the names
  at fault. Shared-history injection is I4 and is deliberately not half-built here.
- Gates: `group-serial.test.ts` runs two Workers over one SQLite file and asserts the
  room's peak concurrency is 1 (falsified: with the exclusion removed it reads 2);
  `room-trigger.test.ts` asserts the code mapping and that a mid-transaction insert
  failure writes nothing; `settle.test.ts` asserts cwd selection without spawning.

### Q39 — I4: group history is injected, never resumed (2026-11-01)
**A**: every group trigger is a clean Pi process that receives the room's shared
history plus its own persona; a group Task never resumes a Pi session, and an
agent's reply is written back into the room stream in the same transaction as
its success.
**R**: Q30 asks for full history including what other agents said, and Q31
forbids resume so the same messages are never handed over twice. Both are
unachievable unless the reply is persisted — see the first bullet.
- **The reply had to be persisted for I4 to mean anything.** Before this,
  `room_messages` was written in exactly one production place
  (`room-trigger.ts`, `authorKind: "user"`); a successful Task's text went into
  `tasks.result` and never touched a room table. Injecting `listMessages` would
  therefore have injected a history containing only user turns: I4 would pass its
  own test while group chat remained an illusion. Upstream has the same fact
  modelled (`senderType = isHuman ? 'user' : 'agent'`, persisted both ways), so
  omitting it would also have been a semantic divergence, not just a gap.
- `buildRoomPrompt(room, agent, members, history, omitted?)` fixes six sections in
  a stable order — persona prompt, `# 角色`, `# 群`, `# 群规则` (omitted when
  empty), `# 成员`, `# 群聊记录`, `# 你的任务` — so the text can be asserted on
  and replayed identically after a crash.
- Authors are resolved from `authorAgentId` through the member list, falling back
  to the raw id when the member is gone: a deleted agent keeps its message rather
  than having history silently rewritten. `user` renders as 用户, `system` as 系统.
- **Truncation is announced, never silent.** `ROOM_HISTORY_LIMIT` is 500;
  `countMessages` counts outside the window, and when anything is dropped the
  history section starts with `（已省略较早的 N 条消息）`. A silent cut would let
  an agent believe it had read the whole conversation.
- `durable-worker` forces `resumeSession = false` whenever `task.groupId` is set
  (Q31). Tasks without a room keep Q18 behaviour and still resume on retry; a test
  pins both halves (`[undefined, undefined]` vs `[undefined, sessionPath]`) so the
  branch cannot rot into "never resumes".
- `completeSuccess` and the agent's reply commit inside ONE
  `store.transaction()`: a Task that succeeded without its reply in the room — or
  a reply for a Task that did not succeed — would desynchronise the stream the
  next trigger injects. Reply content is `structured.summary`, because the worker
  only reaches that path with a validated structured result, so `summary` is the
  one field guaranteed to be non-empty prose; raw `latestText` may be a JSON
  envelope. Idempotent per `taskId`, so a replay cannot make an agent speak twice.
- The group path records `sessionFile` as before (Q18) but never consumes it.
  `WorkerOptions.rooms` is optional and must share the ExecutionStore's
  `DatabaseSync` handle; a mismatched handle throws up front rather than failing
  mid-run.
- Failure is not posted to the room: only a successful Attempt speaks. Recorded as
  a deliberate limit, not an oversight.
- Gates: `room-trigger.test.ts` (prompt structure, author labels, truncation),
  `room-reply.test.ts` (reply lands once, feeds the next trigger, stays out of
  non-room Tasks), `recovery.test.ts` (the resume contrast above).

### Q40 — I6: flow guards are code, and their state is durable (2026-11-01)
**A**: loop detection, the round cap and the termination signal are decided by one
pure function over persisted `RoomState`, enforced at both trigger entry points;
the coordinator is *pushed* toward an ending by a Task the platform queues, never by
trusting an agent to stop on its own.
**R**: AGENTS.md forbids a guard that depends on model behaviour, and Q28/Q29 refuse
to inherit teamagentx's in-memory Map (its AC3.4 accepts losing flow state on
restart). Both rules are only satisfiable if the decision is a pure function over
state that lives in SQLite.
- **Fixed judgement order**: `terminated` → chain membership (LOOP) → round count
  (ROUND_CAP) → allowed, plus `reachesCap` for the trigger that lands exactly on the
  cap. The order is a contract, not an accident: termination outranks everything so a
  closed room cannot be resurrected by a loop-free, sub-cap trigger; LOOP outranks the
  cap so A→B→A is named as a loop even when rounds remain.
- **chain semantics**: one agent id may appear at most once per *user turn*. That is
  what makes AC4.1 (A→B→A blocked) and AC4.3 (user→A→B→coordinator allowed) the same
  rule rather than two special cases — the legal chain has no repeats.
- **Round = one agent trigger** (Q30), counted at the moment the platform commits to
  dispatching, never when the runtime later succeeds. A round is therefore recorded
  for a Task that then fails: the budget measures dispatch attempts, which is the
  thing a runaway loop consumes.
- **A user message resets first, then guards.** `resetState` runs before any target is
  judged, so AC4.2 (chain), AC5.3 (rounds) and AC6.3 (terminated) are one rule, not
  three. Guarding first would let the previous turn's chain block this turn.
- **The wrap-up Task is not charged a round.** Charging it would spend the last round
  of the budget on the escape hatch that needs that budget. Its prompt is the shared
  group prompt (I4) plus an explicit platform directive naming `[讨论结束]`, appended
  last so it cannot read as another member's opinion. If the room has no coordinator
  the cap is announced in the stream instead of pretending a forced ending was
  scheduled.
- **Both entry points share one wrap-up implementation.** A message mentioning enough
  agents consumes the same budget as a chain of handoffs, and AC5.1 does not
  distinguish them; two copies of that rule would drift. Same for the guard itself:
  `applyTriggerGuards` is `postRoomMessage`'s write half, extracted because that
  refusal path is otherwise unreachable in production (`resolveMentions` dedupes and
  the chain was just reset) and would be untested code posing as a guard.
- **Termination rights belong to code.** `[讨论结束]` in the stream is data; only the
  coordinator's reply sets the flag (AC6.1), a non-coordinator's is ignored with a
  warn *and* a system message (AC6.2) so the stream itself explains the silence. The
  marker's author is read from the persisted `is_coordinator` column, so the rule
  survives a restart and a template re-import rather than living in a prompt.
- **Verdicts and writes commit together.** In the worker, guard reads/judgements/writes
  all run *inside* the success transaction: a user message posted while the Task was
  running would otherwise reset the chain underneath a snapshot read and charge rounds
  to a turn that already ended. The room's reply idempotency (`getMessageByTask`) also
  gates the flow-state writes, so a crash replay cannot count a round twice.
- **`RoomStore.tx` became savepoint-based.** `recordTrigger` opened its own
  `BEGIN IMMEDIATE`, which SQLite rejects inside an open transaction (verified:
  `cannot start a transaction within a transaction`) — so any guard call from inside a
  Task transaction would have thrown. `SAVEPOINT` is the primitive that nests:
  standalone it commits, inside another transaction its work is still discarded on the
  outer rollback. A test pins the second property, because the alternative — silently
  keeping guard writes after a rolled-back Task — is the kind of divergence that only
  shows up after a crash.
- **A guard block is a normal result, not a 4xx.** `RoomTriggerError` still means "the
  request was wrong" and still rolls everything back. A refusal by the loop/cap/
  termination guard means "valid request, platform declined": the user message and the
  system message are committed, so the API answers 201 with `blocked`. Rolling a block
  back would delete what the user just typed.
- **State is durable and verified as such.** `round_count` / `chain` / `terminated`
  live in `room_state`; AC6.4 is tested by closing the file, reopening it with new
  handles, and running a Worker that then refuses the handoff — not by asserting a
  field on an object.
- Deliberate limit: the cap counts rounds within one user turn, so a user who keeps
  re-mentioning can extend a discussion indefinitely. That is intended — the guard
  exists to stop agents from burning tokens on each other (PRD Story 4), not to limit
  how much the human pays for their own turns.
- Gates: `room-guards.test.ts` (31 cases, one `it` title per AC: 4.1/4.2/4.3,
  5.1/5.2/5.3/5.4 plus the no-coordinator fallback, 6.1/6.2/6.3/6.4 end-to-end,
  7.1, and the P6 regression for a Task with no `groupId` or no `RoomStore`),
  `room-routes.test.ts` (201-with-`blocked` versus 4xx-rollback, wrap-up queued through
  the route).

### Q41 — I5：两条派发路径，去重在守卫之前 (2026-11-02)
**A**: `handoff_to` 为主路径，agent 自己回复里的 `@name` 为次路径；
同一目标在**同一条源消息**里最多入队一次；
两条路径受**完全相同**的护栏与 I6 三守卫约束。
**R**: Q34 已定两条路径都要识别，Q35 定了按目标去重；
而 `LOOP` 必须只表示真的 A→B→A。
- **去重发生在 `evaluateTrigger` 之前**（`dedupeByOrigin`，`handoff-intent.ts`）。
  若在守卫里"顺路"折叠，第二次命中会被报成 `【流程守卫·循环】` ——
  那是对一个不存在的循环说谎，还会白烧一条用户无法处理的系统消息。
- 优先级由 `ORIGIN_RANK`（`handoff_to: 0`、`mention: 1`）表达，**与列表顺序无关**：
  平局时活下来的是 `handoff_to` 那条，连同它的 reason（Q35）。
  折叠**只对群 Task 生效**：非群任务只有一条路径，
  折叠它两次相同的 `handoff_to` 调用会移动 P6 主干的行为。
- 次路径没有 tool call，幂等锚是合成的 **`mention:<sourceTaskId>`**。
  它必须跨 Attempt 重放稳定，因为 `completeSuccess` 按
  `outbox(source_tool_call_id, target_member_id)` 与
  `idempotencyKey handoff:<chain>:<source>:<target>` 去重；
  `randomUUID()` 或时间戳会让每次重放拿到新键，于是多派发一个子 Task。
- 次路径只解析 `structured.summary`，即**即将写进群流的那段字节**：
  说出口的提及与被履行的提及必须是同一份内容，
  否则群里会出现一次从未发生的派发。
- **与用户路径的不对称是有意的，不是遗漏。** 用户消息里未知/重名的 `@` →
  4xx 且什么都不写（AC2.5，人必须立刻知道没人应答）；agent 正文里的 →
  记录进流但**不失败**：一次已产出有效结构化结果的运行，
  不该被一个文本瑕疵作废；且重名**不派发**。
- 修掉一个真实缺陷：主路径子 Task 的 `input` 原先**不带 `agentDir`/`model`**，
  于是自动接力的子 agent 会在项目 workspace 里以父的模型跑 ——
  直接违背 Q38 的人格隔离与 PRD G2/G3。现在两条路径都经 `personaFields`，
  且**只对群 Task 生效**：非群的 `memberId` 是执行成员、没有 persona 行，
  继承父的 `agentDir` 只会更糟 —— 子任务会冒充成别人。
- Gates: `room-handoff-mention.test.ts`（去重、重放幂等、`@` 路径上的守卫、无群回归）、
  `handoff-intent.test.ts`（`dedupeByOrigin` 与 schema 校验）、
  `mention.test.ts`（两条路径共用一份花名册规则）。

### Q42 — I7+I8：群是一个 thread，作者身份走 custom 消息 (2026-11-02)
**A**: `ChatRoom` 投影为一个 Pi thread，与既有 Task thread 共用**同一套** `/api/pi` 路由；
三栏 UI 由 `usePiRuntime` 驱动。
**R**: Q29 定"一个群 = 一个 thread"，Q27 定服务端权威；
而 react-pi 的 `PiThreadMetadata` 契约里**没有** `kind` 字段，
所以命名空间只能落在 id 上。
- thread id：群 = **`room:<roomId>`**，单 agent = 裸 task id（P7a 线上格式不变）。
  不靠"碰巧不撞"：`ExecutionStore` 只产 `task-<uuid>`、`RoomStore` 只产 `room-<uuid>`，
  分隔符 `:` 不属于任一字母表，且 `threadKind()` 是**全函数**、由字符串本身判定，不查库。
- 作者载体：`role:"user"` 保持**原生** ——
  react-pi 靠同文本的 `role:"user"` transcript 条目对账乐观消息，
  改成 custom 会让用户的话重复显示。agent/system → `role:"custom"` +
  `customType: room-agent|room-system` +
  `details{authorKind,agentId,name,role,emoji,color,isCoordinator,seq,messageId,taskId}` +
  **`display: true`**（`display: false` 会被投影器整条跳过）。刻意**不**把作者名拼进正文。
- 群 thread 状态：任一 Task 在飞即 `running`。**故意不看**
  `roundCount`/`chain`/`maxRounds`/`terminated` ——
  流状态约束的是*未来*触发，不代表当下有无工作，报成 thread 状态就是猜。
  终止通过流里的系统消息可见（Q40）。
- 取消只作用于**当前在飞的那条 chain**。取消群的全部 chain 会把别的链上尚未执行的
  Task（含排队中的收尾任务）直接判成 `cancelled`，而 `cancel_requested=1` 之后
  `retryTask` 永久拒绝该链 —— 那是摧毁尚未发生的工作，不是停止当下的运行。
  空闲群回答 `cancelled: false` 而非 4xx：投影不是一次运行，让停止按钮报错毫无意义。
- 删除 = **tombstone + 取消在飞**，绝不删 P6 行、绝不删群消息
  （"项目拥有工作区，群聊是视图"）。幂等：已不存在也 204。
- 补齐了 `PiClient` 契约缺的端点（PATCH / DELETE / queue-clear / models / model /
  thinking / archive / host-ui），诚实优先于齐全：`queue/clear` 返回空数组是**事实**
  （P6 没有 Pi 的 steer/followUp 队列）；`thinking` 是 no-op 且**不**在
  `metadata.config` 里回显；`GET /models` 用**白名单正向构造**读
  `<agent-dir>/models.json`，凭据字段结构上不可能泄漏；群线程**拒绝**线程级模型
  （`ROOM_MODEL_IS_PER_AGENT`），而不是悄悄覆盖每个人格。
- **记录一条限制而非遗漏**：单 agent thread 只接受**第一条**消息，
  追问返回 **409 `FOLLOW_UP_NOT_SUPPORTED`**。原先的代码调 `retryTask` 并**丢弃**
  `content` 还回 204 —— react-pi 对 2xx 一律 resolve 并保留乐观消息，
  而 transcript 由旧 `task.prompt` 重建，于是用户的话短暂出现后消失、
  worker 重跑旧 prompt。多轮由**群 thread** 承担（Q29）；
  给单个 Task 造有序 turn 列表需要新投影，
  且按 `chainId` 聚合会把 handoff 子 Task 的 prompt 冒充成用户消息。
- I8：三栏（会话列表 / 群聊区 / 成员面板）。渲染**只信 `details`/`customType`，
  不信 `role`**（react-pi 已把每个 `custom` 行重写成 assistant 消息）；
  system 消息**零头像**且样式明显不同（Q40 不许把平台提示伪装成成员发言）；
  `@` 选择器插值到**光标处**；发送前就拦下"无 `@`"与"未知 `@`"
  （后端严格 4xx，不该发一个注定失败的请求），而 `blocked` 是 **2xx 结果不是错误**。
- Gates: `pi-room-thread.test.ts`、`pi-room-routes.test.ts`、`pi-room-client.test.ts`
  （真实 `createPiHttpClient` + 真实 reducer + UI 用的同一套投影规则；
  校验器会**静默丢弃**畸形消息，所以"路由返回 200"什么都不证明）、
  `pi-contract.test.ts`、`pi-thread.test.ts`（单 agent 回归）。
  浏览器验证用真实 Chromium + CDP 跑过（`.i8-evidence/`，未跟踪），**不是**常驻门禁。

### Q43 — I9：技能要真的被加载，判定只有一份 (2026-11-02)
**A**: 技能落 `<agentDir>/skills/<slug>/`，由 `PiAdapter` 逐个传 `--skill <dir>`；
清单/安装/卸载走 `/api/rooms/:id/agents/:agentId/skills`；
"Pi 会不会加载它"的判定唯一地放在 `runtime-core`。
**R**: 实测两个缺陷，不是推测 —— ①`<agentDir>/skills/` **不在** Pi 的发现路径
（项目级是 `.pi/skills/` 与 `.agents/skills/`；`<agent-dir>/skills/` 属于
`PI_CODING_AGENT_DIR`，人格目录刻意不是它）；②适配器从不传 `--skill`。
**结论：导入的技能此前从未生效过。**
- 为什么选 `--skill` 而不是改落盘到 `.pi/skills/`：后者受 **trust 门控**，
  `--no-approve` 下技能会消失（`scripts/pi-smoke-*.mjs` 正是
  `approveProjectResources: false`）；`--skill` 两种 trust 都加载。
- 共享判定放 `runtime-core`：它是写入方（orchestrator）与加载方（runtime-pi）
  **唯一已存在的共同依赖**，放别处要么复制规则（缺陷①正是这么产生的），
  要么反转依赖方向。
- **"看得见但不会生效"是一等结果**：缺非空 `description` 的 `SKILL.md` Pi 根本不加载，
  所以清单返回 `loadable: false` + 具名 `verdict` + 中文 `issues`，而不是静默省略。
- 无技能 Task 的 argv **逐字节不变**，由自己的回归测试钉住。
- 路径穿越：slug 白名单 `^[a-z0-9][a-z0-9-]{0,63}$`、`resolve` 后前缀校验、
  逐文件 `safeRelPath`、卸载再走 `realpath` 纵深；
  **symlink 在 list/inject/remove 三侧一律不跟随**。
- 卸载不存在的技能返回 **404 而非幂等 204**：破坏性操作把一个 typo 报成成功更危险。
- 范围如实记录：I9 交付的是**服务面**（清单/安装/卸载，全部有门禁）加注入。
  `packages/web` 里独立的技能**页面**仍未做（见 `docs/architecture.md` §9）。
- Gates: `orchestrator/src/skills.test.ts`、`runtime-pi/src/skills.test.ts`、
  `server/src/skill-routes.test.ts`、`skill-import-e2e.test.ts`
  （导入→清单→argv 是**同一个事实的三次读取**；真实 pi 用例 `MTA_REAL_PI=1`）。

### Q44 — I10：真实模型验收，以及它暴露的六个缺陷 (2026-11-02)
**A**: PRD §6 六项在真实模型下全部通过，由 `scripts/prd-acceptance.mjs` 可重复执行 ——
真实 `pi` + 真实 provider + 真实服务端 + **独立进程** worker + 同一 SQLite
（`MTA_RUNTIME=mock` 直接 abort）。
**R**: 此前只覆盖过 §6 第 2 项与守卫的 mock 级证明。
- **验收的价值在于它推翻了我们自己的假设。**
- **D1（高）**：`handoff_to` 在 Pi 1.4.0 里**根本不存在**
  （内建只有 read/bash/edit/write/grep/find/ls），
  于是 Q34 所称的"权威主路径"**从未在真实运行里触发过**，I5 的去重有一半不可达。
  修法：自带 `pi-extensions/handoff-to.js`，经显式 `--extension` 加载
  （显式路径不受 `--no-extensions` 与 trust 门控）。记一句事实：`PiAdapter`
  默认就传该 flag（`handoffExtension: true`），所以 `runtime.ts` 无需改动，
  缺的是扩展文件本身。`execute()` **只登记不派发**（派发在提交事务里，P6 权威）。
  `--extension` 是**可重复叠加**，不是 last-wins（实测）。
- **D3（中）**：`agentDir` 只是 cwd，Pi 会话默认写全局 `~/.pi/agent/sessions`，
  按目录**分组是命名约定不是访问边界** —— 真实模型实测能 `read`/`bash`
  翻出其他群、其他角色的完整发言。修法：有 `agentDir` 时传
  `--session-dir <agentDir>/.pi/sessions`（实测与 `--session <path>` 共存不冲突，
  `messageCount 3→5`，Q18 优先）。完整沙箱属 P7b。
- **D5（高）**：`handoff_to` 的目标**不校验花名册**，模型填名字时会静默建出
  `agent_dir=NULL` 的子 Task 去空转失败；而注入的「# 成员」段**从不含 id**，
  schema 却要求 "exact ids"。修法：`resolveRosterTokens` 复用 `@name` 那套
  id/名/角色规则（名优先、重名 ambiguous 不猜），解析不出即**拒绝 + 系统消息**；
  花名册行**追加** id 而**不改** `memberLine` 字节（Q39 的逐字重放断言钉在它上面）。
  护栏因此看到**已解析的 member id** —— `revisit ≤ 5` 按 id 计数，
  否则经 `工程师` 三次触达与经 `agent-<uuid>` 三次触达会被算成两条链。
- **D6（中）**：主路径子 Task 的 prompt 原先只有 `workPackage`，
  **没有角色 prompt/群身份/群历史**，与 Q30/I4 不一致；
  D1 修好后这条分歧才第一次真实可达。修法：两条路径共用
  `dispatchInput`/`buildDispatchPrompt`，且**每次运行只读一次群快照**
  （两次读会让同批两个孩子对"群里说过什么"意见不一致）。
- **D2/D4（中/低）**：`@架构师` 按**角色**解析（PRD §6 原文就是这么写的）；
  `@ts-ignore`/`@types/node`/`@media` 不再被当未知成员 —— **闭合小写清单** +
  "群若真声明该词则白名单让位"的逃生门。**绝不**用"看着像 ASCII 就当代码"的启发式：
  成员名合法地可以是 ASCII，误吞一个真名字是**静默丢派发**。
- **D5-b / D6 已在修复后重跑并直接观察到**（不再是只有单测证明）：
  `outbox.source_tool_call_id = call_00_O7IT5wtOXBuenYDt2GOx3110`（真实 toolCallId），
  本轮模型调用的工具只有 `[handoff_to]`、**没有 `bash`**，注入的花名册有 5 行带 `｜id: agent-…`
  （修复前恒为 0 行），故不再需要翻磁盘；子 Task 的 prompt 含 `# 角色：`、含 `# 群聊记录`、
  含父这条回复原文，末尾才附「# 交接任务说明（来自 高见远，…）」；
  阶段 B 要求只写名字时模型填 `"寇豆码"`，被解析成真实 `target_member_id` 且子 Task `succeeded`
  （D5-a 的"名字/角色/id 三种写法"端到端成立）。完整群注入没有拖慢运行：第 3 项 142.6s→49.9s，
  全量 349.5s→209.4s。
- **更正一条我自己写错的归因（第 5 项的"不稳定"）**：先前记录为"强制收尾依赖模型输出
  `[讨论结束]`，r7 三次 Attempt 全失败所以不稳定"。验收脚本后来直接复现出那个形状并给出真因：
  `Attempt#1 status=failed error=no events for 120000ms` —— 这是 P6 stall watchdog 的
  **无事件超时**（`durable-worker.ts` 的 120s，provider 挂起），三次 Attempt 各撞一次，
  协调者根本没拿到模型响应。**把基础设施故障记成了被测行为**。
  由此确定判定分层：只有守卫真的漏放（上限已满仍建出目标 Task）才是 FAIL；provider 挂起、
  预算耗尽、模型不肯按指令 @ 人一律 BLOCKED 并给出具名原因；判定前先给平台自动重试留窗口
  （`retry_wait` 不是终态）。断言条款一个没减。
  同时确认一个队事实：worker **串行**（`runOnce` 一次只领一个），所以一次挂住的运行会饿死
  后面所有群的任务，它们全停在 `queued` —— 在消息流里与"守卫没生效"长得一模一样，
  这正是我此前两次误诊的来源。13 次抽样里那次唯一 FAIL 属于此类，不是模型措辞。
- **仍未证明的（不要写成已证明）**：
  - ~~AC5.2 的 `ROUND_CAP` 真实拒绝未被直接观察~~ → **已补上，这条限制作废**：
    第 5 项新增独立真实模型探针，直接观察到
    `【流程守卫·轮次上限】齐活林：本轮已达轮次上限（1/1），不再处理新的 agent 触发`，
    目标 Task 数 0。能观察到的前提是两个条件同时成立，缺一即先撞别的分支
    （判定顺序 `terminated → LOOP → ROUND_CAP`，`room-guards.ts:39`）：
    ①群未被终止 —— 把 `coordinator_agent_id` 置空（顺带验证 Q40 无协调者回退），
    `terminated` 不会变真；②目标在链外 —— 否则先命中 `LOOP`。
  - I8 的浏览器验证是一次性脚本，**不是**常驻门禁。
- Gates: `node scripts/prd-acceptance.mjs`（手动：需要 pi + provider + 网络，
  与 `just pi-smoke` 同类，**不入 CI**）。当前代码上一次全量运行退出码 0、209.4s；
  离线门禁 `just build` / `just check` 退出码 0，
  `pnpm vitest run packages/orchestrator packages/server` 为 Test Files 26 passed、
  Tests 395 passed / 2 skipped。

### Q45 — 全局 CLI 的 PATH 错配，与"找不到就跳过"的幻影门禁 (2026-11-04)
**A**: 需要全局 CLI 的脚本一律经 `scripts/resolve-bin.mjs` 解析**绝对路径**（PATH →
fnm/nvm/volta/asdf 各版本全局 bin，版本目录按数值降序），并把解析出的目录**前置进
`process.env.PATH` / `export PATH`**；单二进制覆盖用 `MTA_BIN_<NAME>`。
`pi-smoke.sh` 的前置缺失改为**非零退出**。验收脚本进场先跑 **provider 预检**
（一次极小的真实模型调用），预检不过直接退出码 2，不进六项。
**R**: `spawnSync("lark-cli")` 报 ENOENT，而脚本的错误文案写的是 "install it and run
`lark-cli auth login`" —— 它把 PATH 错配说成未安装，于是排查从"重装"开始，而重装解决
不了 PATH。`~/.lark-cli/logs/auth-*.log` 里 cmdline 一直是
`.../fnm/node-versions/v22.22.1/installation/lib/node_modules/@larksuite/cli/bin/lark-cli`
（10-30 至 11-03 都在正常写日志），这就是"装了但当前 shell 看不见"的直接证据。
- **同一个根因命中两个二进制**：`lark-cli`（飞书同步）与 `pi`（真实模型验收）都装在
  装它们时那个 node 版本（v22.22.1）的全局 bin，而当前 shell 是 v26。`pi` 那条更严重：
  `pi-smoke.sh` 原来是 `command -v pi || { echo SKIP; exit 0; }` —— 门禁没跑却报通过，
  而 `AGENTS.md` 明写 "Without these the smoke exits nonzero"。**代码违背文档**，
  且正是 Enforcement Index 反对的幻影门禁形状。
- **绝不做 `feishu-cli` 回退**：它是另一个工具（v1.29，`doc`/`bitable` 子命令），
  与脚本用的 `docs +update` / `base +table-list` 简写语法命令面不兼容；回退只会把
  "PATH 里没有"换成一条更费解的 "unknown command"。
- **keychain 的真实状态（2026-11-10 更正）**：这里的旧结论 —— "主密钥已丢失、
  唯一出路是重新授权" —— 是**错的**，它把"活动 profile 坏了"误诊成"整台机器的凭据坏了"。
  实测（均为只读命令，可复现）：
  - `lark-cli profile list` 有两个 profile：`cli_aa5e5b0f0238dccf`（`active=true`
    但 `tokenStatus=error`）与 `mta-sync`（`tokenStatus=valid`）。**坏的是活动的那一个。**
  - `master.key.file` 在 `~/Library/Application Support/lark-cli/`（32B，非
    `~/.lark-cli/`），密钥**是好的**：用 AES-256-GCM（nonce 取密文前 12 字节）能解开
    `appsecret_cli_aa9040474fb8dcbd.enc` 与 `cli_aa9040474fb8dcbd_ou_92c7…enc`；
    解出的 user token `expiresAt=2026-11-10T02:03:12`、`refreshExpiresAt=2026-11-17T00:03:12`
    —— **不是**"2026-05-31 过期"。解不开的只有 `cli_aa5e5b…` 那套（旧主密钥加密）。
  - 因此 `keychain not initialized` 的真实含义是：该 profile 的密文用已不存在的旧主密钥
    加密，解不开后回落空的钥匙串 —— 不是沙箱封锁，也不是主密钥被删。
  - `config.json` 的 `appSecret.source` 至今仍是 `keychain`，`keychain-downgrade`
    确实没翻转它；但 **`credentialSource` 才是运行期实际用的读法**（好 profile 报
    `"local"`），`source` 只是 appSecret 这一个字段的登记方式，不足以判定"降级没生效"。
- **修法只需切换活动 profile**：`lark-cli profile use mta-sync`（一次性、可逆，
  `lark-cli profile use -` 切回）。切换后**不带任何环境变量**实测：
  `sync-docs` 10/10、`sync-bitable` 7/7、`verify-docs`、`verify-bitable` 全部 exit 0，
  且 `wiki +node-get` 用该 profile 返回真实节点（`owner=ou_92c7…`）。
  排查脚本**不需要**改代码：它故意不传 `--profile`，跟着活动 profile 走 —— 这是对的，
  把 app id 硬编码进仓库反而会让换机器/换 app 时必须改代码。
- **建节点不再是人工步骤**：`sync-feishu-docs.mjs` 原先遇到占位 ID 就**拒绝**并要人去飞书
  建节点、把 token 抄回 manifest —— 而 `sync-feishu-bitable.mjs` 早就用
  `wiki +node-create` 自己开通 Base 并回写配置。同一个仓库里两套约定，docs 那套还把
  "没人正好带着授权终端"当成设计前提，于是 3 个 PRD 节点一直 pending。现在 docs 脚本也
  自己建（标题取 manifest 的 `node` 字段），并**在推送正文之前**回写 ID：若正文失败而
  manifest 仍是占位，下次重跑会为同一文档建出**第二个节点**，重复比"落后一个版本"更难收拾。
  拒绝仍然保留在真正拒绝得掉的地方：没有 `node` 标题、或建节点被上游拒绝。
- **半开通状态必须可恢复**：先写 `node_token` 就意味着可能出现"节点已存在、
  `document_id` 还是占位"这一半状态。把它当"没开通"会建出重复节点，所以 `ensureNode`
  先判 `halfProvisionedNodeToken`，命中就走 `wiki +node-get` 解析 `obj_token` 补齐，
  **绝不**再建。空 `document_id` 也算缺失：`placeholderOf` 刻意不把 `""` 当占位
  （另有 `entry missing "document_id"` 检查负责报它），两处判据必须一致，否则
  离线校验与 provision 会对同一条目给出相反结论。
- 顺带修 `runLark` 的失败解析：lark-cli 被拒时 stdout 为空、失败 JSON 在 **stderr**，
  docs 脚本只解析 stdout，于是把"未授权"报成 `non-JSON output` —— 正是该文件注释里
  声称要避免的"两种根因不可区分"。现在与 bitable 脚本同构（两路都看、`ok:false` 提取
  `error.message`、凭据类失败附一条可执行的 `auth login` 提示）。
- **预检的动机是省下整轮误诊**：provider 挂起时六项各烧满单项预算（每项 5 分钟），
  最后产出一墙 BLOCKED，而"provider 无响应"与"产品缺陷"在那一墙里长得一模一样 ——
  Q44 记录了我因此错两次。预检把这件事压到 ~2 分钟，且退出码 2 与产品结论（0/1）分开。
  预检只在本次确实要跑需要模型的项时执行：`MTA_I10_ITEMS=1`（导入验收）不该被
  provider 状态绑架；`MTA_I10_SKIP_PREFLIGHT=1` 可跳过。
- 取舍：解析顺序里 PATH 优先于版本目录，所以正常安装不受影响；版本目录按数值降序，
  避免 `v9` 在字典序上赢过 `v26`。

### Q46 — 写后读不一致与"建了但不告诉你 id"，都是没测量就假设响应形状 (2026-11-04)
**A**: 授权成功后的第一次真实同步暴露两个上游形状假设错误，两个都只在**真调**时可见：
- `base +table-create` **不返回 `table_id`**。响应是
  `{"ok":true,"identity":"user","data":{"fields":[...]}}`，只回显输入 schema。
  现改为建完重读 `+table-list` 按名认领（`adoptCreatedTable`），且**只认领建表前不存在的
  id**：同名表若在 `before` 里，说明那是别人的表，绝不能挂上去；重名多于一概拒绝。
- `base +record-batch-create` 返回 ok 之后，紧接着的 `+record-list` **仍可能读到写前快照**。
  第一次跑 10 条 `项目阶段` 全部写入成功（手工查询可见），脚本的校验读看到 0 条，
  于是报 `MISMATCH` + `exit 1` —— **正确的同步被报成失败**。现只对"本次确实写过"的
  校验读做 4 次退避重试（1.5s/3s/4.5s）；无写入不重试，真失败仍失败。
**R**: 前者若继续抛错，比不报错更糟：表**已经建出来**，每次重试再留一张同名表。
后者是假失败，且形状极具误导 —— 它看起来和"写入被拒"完全一样，会让人去查权限。
两次都是把 bitable 脚本的响应形状当成了通用形状去推断：`obj_token == document_id` 这条
核心假设此前也只是推断，现已用真实 `+node-get` 钉在 `scripts/feishu-docs.test.mjs` 里。
- **回写 manifest 必须保格式**：`docs/feishu-bitable.json` 的字段定义是手工一行一条排的，
  `JSON.stringify(config, null, 2)` 把一次**两行**的 provisioning 变更变成 **436 行**
  的格式噪音，review 时真实变更被淹没。现在只对 `base_token`/`node_token` 做定点替换
  （`patchProvisionedIds`），语义不变时整文件字节不动；键缺失或出现多次则退回全量重写，
  不猜。
- **授权仍是人工步骤，但它只该发生一次**：`offline_access` 已在 app 的 217 个 scope 里，
  授权一次后靠 refresh token 续期（本次 `refreshExpiresAt` 2026-11-11）。此前 4 次
  失败不是凭据问题，是 device code 的 **600s 服务端硬窗口**和我发消息-用户读到之间的延迟
  赛跑；把码直接放进回复并同时挂后台轮询后，93s 完成。

### Q47 — `thinkingMode` 的断链：三段都有测试，缝上没有 (2026-11-10)
**A**: `RoomAgent.thinkingMode` 现在真的进到命令行。`durable-worker` 新增
`personaThinking(task, memberId)`，在每次运行时按成员 id 从花名册派生
`RunSpec.thinking`，接入主 `start()` 与 `dispatchInput()` 两处。
**R**: 这条链的两端当时都已经有测试 —— `thinking_mode` 落库（`room-store.test.ts`）、
模板迁移（`template-import.test.ts`）、Pi 把 `spec.thinking` 变成 `--thinking`
（`runtime-pi/src/skills.test.ts` 连 argv 顺序都钉死了）。**唯独中间那段没人测**：
worker 构造 `RunSpec` 时压根不设 `thinking`，于是群声明 `thinkingMode: "high"`
静默按适配器默认值跑。两端都绿、行为却是错的，这比任一端漏测更隐蔽 ——
断言必须落在"worker 交给适配器的 spec"上，因为那才是值消失的地方。
- **派生，而不是写进 Task**：`tasks` 表没有 `thinking` 列，加列要在这个
  `node:sqlite` 实验内核上手写 `ALTER TABLE`（Q44 已记两次列补丁的技术债）。
  派生还顺手解决了另一件事：`dispatchInput` 派出的子 Task 也在 `execute` 里跑，
  于是子 Task 用的是**自己**的 `thinkingMode`，不是父的 —— 这本来就是正确语义，
  若把值复制到父 Task 再继承，就会变成"架构师想多深，QA 也被迫想多深"。
- **取值必须收紧**：`thinking_mode` 是 `TEXT`，值来自模型写的团队模板。
  `--thinking` 是拼进 argv 的，原样透传等于让模板内容控制一个命令行 token。
  现在按 Pi 的闭合集合（`off/minimal/low/medium/high/xhigh/max`，见
  `runtime-core/src/adapter.ts:80`）判定，集合外一律丢弃并保留适配器默认值 ——
  一个错的推理档位不该把整次执行废掉。
- **代价写在明处**：编辑 `thinking_mode` 从下一次触发生效（含重试），不是当次。
  这与人格技能在 spawn 时读取的规则一致，所以"人格作用域的设置按次读"是一条规则，
  不是两条例外。
- **证伪过**：撤掉两处接线后，`thinking-mode.test.ts` 的 5 条里有 2 条立刻变红
  （父档位、子 Task 用自己的档位），其余 3 条按设计仍绿 —— 那 3 条断言的是
  "没有声明时不要凭空发明一个档位"，与接线无关。新增测试若撤掉修复还全绿，
  它证明的就不是修复。

### Q48 — 一个坏 agentDir 打死整个 Worker，以及"ENOENT"的两副面孔 (2026-11-11)
**A**: `runtime-pi` 的 spawn 失败不再杀死进程：`streamEvents` 里新增 `failRun()`，
同时（1）终止事件流、（2）reject `done`、（3）`done.catch()` 兜底；
`settle()` 收到 `cwd`，用 `spawnFailureMessage(error, cwd)` 把 ENOENT 分叉成
"工作目录不存在"或"`pi` 不在 PATH 上"两种具名结论。
**R**: 端到端验证 `thinkingMode` 时撞出来的。前若干轮每次都停在
`Error: spawn pi ENOENT`，错误读起来就是"pi 没装"，于是排查方向是 PATH ——
而真因是我自己脚本里那个 `persona-arch` 目录**从未创建**。实测确认 Node 对
"cwd 不存在"与"二进制不存在"给出**逐字相同**的 `ENOENT / syscall: "spawn pi" /
path: "pi"`，所以那条错误在两种成因下无法区分。这正是 Q45 记过的同一类误诊
（把 PATH 错配说成未安装），只是这次误导的方向换成了 cwd。
- **为什么必须修**：`PiAdapter.streamEvents` 把 spawn 错误交给 `fail(err)`，
  而 `fail` 只 reject `streamEvents` 返回的 `done`。**那个 Promise 返回后无人观察**
  （`start()` 只交出 `events.iterable` 和 `settle()` 两条通道），未处理拒绝在
  Node ≥15 直接致命 —— 于是一个 `agentDir` 被删掉的 Task 会带走整个 worker 进程，
  连带**所有群里排队中的任务**。AGENTS.md 对 dispatcher 明写"a runtime that throws
  on `start()` must degrade to `failed`, never propagate"，而真正违背它的却是
  runtime 本身。这条不变量此前只在 dispatcher 一层被检查过。
- **诊断放在错误出口，不做 `start()` 预检**：预检 `existsSync(agentDir)` 会把大量
  使用合成 `agentDir`（`/persona/arch` 之类）的既有单测全部判失败，等于把一个
  诊断变成行为变更。放在 `settle()` 的 `error` 监听里，只在真的 ENOENT 时才查
  一次 cwd，非 ENOENT 原样返回。
- **事件流必须一起终止**：只挂 `done.catch()` 会让消费者的 `for await` 永远等一个
  再也不会写字节的子进程 —— 证伪时两种撤法暴露两种不同的失败（撤 `failRun` →
  测试超时；撤 `done.catch` → 2 条 unhandled rejection），所以这两半都是必需的，
  不是冗余。
- **真实端到端取证**（真 API 进程 + 真 worker 进程 + 真模型，同一队列两个任务）：
  worker 存活、坏任务 `failed` 且错误点名缺失目录、排在后面的健康任务照常执行并
  真实发言。`thinkingMode` 那条链也同批取证：PATH wrapper 记录到的真实 argv 含
  `--thinking high`，任务 `succeeded` 且回复落进群流。

### Q49 — P9a 事件入口：D1-D6 定案与四条不变量 (2026-11-11)
**D1/B**: 规则存 `trigger_rules` 表 **且** 可 `GET /rules/export` 成 `rules.json` 单向导入（Git 可审）。**D2/A**:
`inbound_events` 新表 + `tasks` 加 `lane`/`event_id`/`tools`。**D3/A**: 一规则一目标。**D4/A**: 定时器在**进程内**
（worker 进程，因为它负责建 Task），`missed:"once"` 幂等。**D5/A**: `lane` 与 `groupId` 分开，`parallel` 只允许 1。
**D6/A**: 入口默认**关**，`MTA_INGEST_ENABLED=1` 才开。

**R**: 四条踩过的坑，都不是可推断的：

1. **`events` 表名已被占用**。`ExecutionStore` 早就有一张 `events`(持久化 per-attempt 事件日志)，而新表**共用同一个
   数据库文件**。`CREATE TABLE IF NOT EXISTS events` 会静默 no-op，然后在第一次 INSERT 才炸。新表因此叫
   `inbound_events`。
2. **AC5.2 照字面写是"永远无法通过的门禁"**。PRD 说「目标 agent 的可写工具配置在 P9d 隔离落地前拒绝登记」，
   但 `RoomAgent` 没有工具字段，Pi 默认就是 `read,bash,edit,write` —— 照字面实现会拒绝**每一条**规则。
   AGENTS.md 明禁这种"无法通过的幻影门禁"。实测 `pi --help` **有 `--tools` 允许清单**，于是把门禁做成真的：
   规则只能声明只读工具集，`validateRuleInput` 拒绝任何可写项，且这个清单**随 Task 落库、由 worker 传进
   `RunSpec.tools`、最终成为 `--tools` 参数**。只在登记口拦一下而不到执行，就是幻影门禁。
3. **`lane` 不能复用 `groupId`**。`groupId` 在 P8 已承载三重语义，且 worker 里 `!task.groupId` 决定
   `resumeSession`（Q31）——事件任务若拿 `groupId` 当串行键，会连带关掉会话续用、并读一个不存在的 Room。
   `claimNext` 改成 `COALESCE(lane, group_id)`，**Room 分支逐字节不变**（AC3.3 用现有 group-serial 测证）。
   代价说清楚：`COALESCE` 是**一个键空间**，所以一个恰好叫 `room-<uuid>` 的 lane 会与该 Room 串行 —— 这是
   契约不是 bug，测试里钉住了。
4. **`cronTasks` 由丢弃改为转换（AC4.3 反转 Q31）**。`scheduleType!="cron"`（一次性/间隔）与无法解析的表达式
   **具名拒绝**，不猜成定时任务；拒绝项进 `cronRefused` 与 warnings，仍然"不静默"。

**迁移账本**：顺手把 P8 补丁的另一半做了 —— `schema_migrations` 表 + `applyMigrations`，替掉 `ExecutionStore`
构造函数里那段手写 `PRAGMA table_info`。账本本身是新的，所以**每个 `up` 必须幂等**：对账本存在前建的库，
账本是空的但列可能已在，靠 `addColumnIfMissing` 先看现实再动手。

**证据**：`ingest.test.ts`(9) + `ingest-guards.test.ts`(9) + `ingest-cron.test.ts`(9) + `migrations.test.ts`(7) +
`server/ingest-routes.test.ts`(8) + `runtime-pi/tools-allowlist.test.ts`(3)；真实服务进程 15/15（真 socket、
401、`--tools`、注入围栏、重投 200）。

### Q50 — P9b/P9c/P9e：把"声明了但没强制"的五件事变成可证伪的 (2026-11-12)
**A**: 五条都改，其中一条**推翻 Q49 的 D5 后半**：

1. **鉴权（取代 Q49 D6 的"令牌可选"）**。旧契约是"没配令牌 => 只绑回环，不鉴权"，
   于是 `MTA_INGEST_ENABLED=1` 单独就是一个**开放入站端点**，而 `/api/health` 对此
   一字不提。现在：开了就必须有 ≥24 字符的令牌，否则**关闭并报 reason**；
   `MTA_INGEST_ALLOW_ANON=1` 是唯一匿名通道，且启动即在 stderr 告警。
   - **短令牌绝不降级成匿名**：那会把一次误配变成一扇开着且有"有人设过令牌"说辞的门。
   - 比较走 `timingSafeEqual`；长度不等时与自身比较，使返回值不从响应时序里漏前缀。
   - POST 路由带 64 KiB `bodyLimit`。`normalizeEvent` 的截断发生在 Fastify **已经把
     整个 payload 缓冲之后**，所以只有路由级上限才是对**字节**的约束。
2. **速率/去重计数**：先前报告说它们是进程内的，**说错了** —— 它们在 SQLite
   （`countDispatchesSince`）。真正的竞态在别处：`redriveDeferred` 先读 `dueRetries()`
   再**无条件** `clearRetry()`，两个 worker 会各自 redrive 同一事件。幂等键挡住了重复
   Task，但**输家仍把决策重跑一遍**，看到赢家的 lane claim 后把结局从 `dispatched`
   改写成 `coalesced`，并顺手推迟了那个刚建好的 Task。改为 `claimRetry`：一条条件
   UPDATE，在既有 `BEGIN IMMEDIATE` 内，只有一个人看到 `changes=1`。
3. **`max_file_lines` 以前是"一个没人读的数字"**。新增 `scripts/check-file-size.mjs`，
   **棘轮**而非大爆炸：既有超标文件按**当前行数**记入 baseline，只能减不能增；新文件
   超标即失败；文件已降回限额内而 baseline 条目未删也失败（否则豁免会永久化）。
   选棘轮的理由：要求先拆完四个不相关文件才准提交会阻塞无关工作，而把限额抬到能容纳
   它们会让这个数字变成假话。已实测**确实会失败**（801 行新文件；baseline 文件涨 1 行），
   并且它当场逮到我自己在 `durable-worker.ts` 造成的增长（904→959），逼我改成拆分而不是
   重设 baseline。
4. **拆分**：`template-import.ts`(1166，动工前已超标) 按它**自己文档里的三段式**切开
   —— `template-types` / `template-readers` / `template-parse` / `template-import`(425)；
   公开面不变（旧 import 站点照旧解析，106 个既有测试一字未改地通过）。
   `durable-worker.ts` 分出 `worker-result.ts` / `worker-notes.ts`，落在 901（baseline 904）。
5. **P9b/P9c/P9e**：
   - **`error_kind` 是闭集，且在各调用点显式赋值，绝不从散文里猜**。预算耗尽进
     `blocked` 而不是 `retry_wait`：重试一个已经花完预算的 Task 只会再花一遍，然后把
     结果叫作 `failed`，等于把运维设的上限算成 agent 的错。检查放在**解读回复之前**，
     否则被预算截断的回复会被报成 `result_invalid`。
   - **`tell` 终于被消费**。单一通道（`MTA_TELL_WEBHOOK`，未配置即沉默）；`tell_log`
     账本按**通知的身份** `(rule, subject, kind)` 建键，而不是按 Task —— 所以"定过的事
     不问第二遍"能跨重试、跨进程重启成立。冷却是**另一套机制**：身份与频率是两件事。
     先认领后发送 => 已送达者永不重发，被拒者可重试。
   - **`skill` 之所以一直无效，原因比注释写的更深**：事件 Task **不带 `agentDir`**，
     而 Pi 的 `--skill` 正是从 `agentDir` 推导的 —— 所以任何事件驱动的 runs 从来加载不到
     任何 persona 技能。现在派发时逐个解析 persona（agentDir/model/可加载技能），登记时
     拒绝目标并不持有的 slug，prompt 里在**指令语态**点名该技能（绝不放进围栏数据块）。
   - **`parallel`：推翻 Q49 D5 的"只允许 1"**。PRD 说放开要改内核，确实改了：`claimNext`
     的谓词从"该键有活 Attempt 就排除"改为"**按 Task 的 `parallel` 计数**"。键空间
     **没动**，所以 `parallel=1` 与旧的 `NOT EXISTS` 完全等价 —— `group-serial.test.ts`
     **未经修改即通过**。I3 AC3（一群一并发）是 **Room 模型的不变量**，不是谁都能调的旋钮，
     因此 `insertTask` 对带 `groupId` 的 Task 一律钳到 1，不指望调用方记得。上限 8：
     一条无上限的 lane 就是"把整个 worker 池交出去"的原语。
   - **P9e 读了对端的真实字节**，发现任何单测都抓不到的缺口：`wakeAgent` 发的是
     `{id,type,subject,summary,detail,link}`，**根本没有 `source`** —— 按 P9a 的实现，
     文档里那个对端的每一条告警都会吃 400。新增 `MTA_INGEST_SOURCE`；验收脚本用
     resolve hook 直接跑**上游自己的** `wakeAgent`。

**R**:
- **`bodyLimit` 不是插件级选项**。Fastify 只在**路由级**读它；挂在 `register()` 上会
  被静默忽略，测试里表现为"超大 body 照样 200"。
- **JS 模板字符串里写 SQL 注释不能带反引号**，两次踩中（`tell_log` 建表、`claimNext`
  谓词）：反引号会终止模板，报错位置还落在后面的行上。
- **`ruleFrom` 里硬写了 `parallel: 1`**（P9a 的假设留在读取端）。登记返回真实值、
  重新读取返回 1 —— 同一个规则会不会并发，取决于它有没有被重读过。
- **测试脚手架自己也会骗人**：探针最初用"每进程峰值"衡量跨进程并发（两个进程各 1，
  看起来就是 1），又因为 runner 会把 Task 重新排队、而 `claimNext` 按 `created_at`
  排序，导致后一组 lane 被前一组的残留饿死。改为**每探针独立库 + 全局区间扫描**才测到
  真相。这类"指标看不见被测对象"的坑，与产品缺陷同样值得记。
- mock runtime 声明 `usageAttribution: "message"` 却**不产出 usage 事件** —— 与
  `02d532f` 同一类 bug，并且它让 token 预算在真实模型之外根本无法验证。现已产出。

**证据**：单测 564 passed（总 569，5 个 `MTA_REAL_PI` opt-in skip）；真进程
19/19（真 HTTP server + 真 worker + 真 webhook 接收端：401/404/413/预算 blocked/
卡片一次且仅一次）；P9e 11/11（跑上游 `wakeAgent`，含"重发 3 次仍只有 1 个 Task"）；
并发 3/3 以**两个 OS worker 进程的全局峰值**度量（`parallel=2` 重叠、默认仍为 1、
`parallel=4` 被进程数封顶）。门禁 `check`/`test-no-build`/`verify-docs`/`verify-bitable`/
`verify-packages`/`test-guardrails`/`test-scripts`/`verify-file-size`/`verify-import` 全 0。

**仍未做，且不粉饰**：**P9d 执行隔离**（本机有 docker 二进制但 daemon 未运行，任何
"已隔离"的断言都无法测量，因此不写）；真正的鉴权/租户隔离/审计（P7b）。


## Q51 — P9d 执行隔离：把"拒收"换成"测到才收" (2026-11-12)
**A**: AC5.2 原先在登记处一律拒绝可写工具。那个拒绝是对的，但它把一种能力变成了**不可能**，
而不是**安全**。现在隔离真的存在，于是规则从"永远拒绝"变成"测到隔离才允许"。

1. **同一份 argv，换一个启动器**。`PiAdapter` 造 `pi --mode rpc …`，隔离层用
   `docker run … <image> pi <同一份 argv>`。挂载沿用**宿主绝对路径**，所以
   `--session`/`--session-dir`/`--skill`/`--extension` 一个字符都不改。
   代价：这些路径必须被挂进容器。收益：隔离版不是"第二套、少测的启动路径"。
   **反例就是本仓库的 D1**：`handoff_to` 曾以为 Pi 内建，结果是"跑了但主路径不存在"。

2. **`sandbox` 必须说真话，且被用来拒绝**。`PiAdapter.capabilities.sandbox` 以前恒为
   `"none"`（对 Pi 是诚实的）。现在它等于 `isolation ? "workspace-write" : "none"`，
   而 `durable-worker` 在 spawn **之前**据此拒绝可写 Task（`blocked` / `isolation_unavailable`）。
   为什么登记门不够：登记是**时刻**，执行是**事实**。一条在 daemon 正常时登记的规则，
   不能在 daemon 停掉之后继续无隔离地跑；直接写进 store 的 Task 更是从未经过登记。

3. **不传门 = 拒绝**。`validateRuleInput` 的 `writableTools` 参数可选，缺省即拒绝。
   一个忘了传参数的调用点**不能**因此获得更宽的权限 —— 这是可选参数最常见的错误方向。

4. **两个只有踩过才知道的坑**：
   - tmpfs 必须挂在 `$HOME/.pi/agent` **本身**。挂父目录时，docker 会为 `models.json`
     的文件挂载把 `agent/` 建成 root:root 0755，uid 1000 无法 `mkdir sessions`，
     每次运行 `EACCES` 死掉。`mode=1777` 才让非 root 可写。
   - `killing docker run` **不等于**杀容器。`--rm` 只处理正常退出；中止时必须
     `docker kill <name>`，名字由 attempt id 确定性推导，否则只能靠列举去猜。

5. **"daemon 未运行"与"镜像准备不了"是两个阻塞**，我此前把它们当成一个。启动 Docker
   Desktop 后 daemon 可用，但 `docker.io` 在本机网络**不可达**（`auth.docker.io` 超时）；
   本地已有 `node:22`，容器内可达 `registry.npmmirror.com`，于是镜像可**完全离线**构建。
   教训：把环境限制写进"未做"之前，先分别验证每个子前提，否则一条本可解除的阻塞
   会被永久记成事实。

6. **出口网络是策略，不是保证**。默认 `--network bridge`，因为模型端点在远端；
   `none` 会让每次隔离运行在第一个 token 处失败，那样的"隔离"只测到了它坏掉的样子。
   真正的出网白名单需要代理/策略层，属 P7b 之后。这条**写进** PRD §7 与架构 §6.8 末尾，
   而不是留给读者自己发现。

7. **阴性对照是验收的一部分**。`just p9-smoke` 的 `iso` 项除了在容器内实测
   uid/rootfs/宿主可见性/`CapEff`/`pids.max`，还跑一次真实模型的写文件任务，
   再用**同一条规则**在关掉隔离的部署上跑一次：必须 `blocked`、必须不 spawn、必须没写出文件。
   只证明"隔离时能跑"而不证明"不隔离时不能跑"，等于只测了一半。

8. **"真实模型写文件"这一半已经跑通（2026-11-12，`iso` 15/15，exit 0）**，但它逼出了两条
   关于 provider 的事实，值得记下来，因为它们解释了脚本里那些看起来多余的等待：
   - **配额按 token/分钟、且与别人共享**：1 token 探针能过，Pi 的默认系统提示（实测
     2048 字符 ≈ 683 token）加一个工具 schema 就过不去。所以验收任务在工作区放一份
     `.pi/SYSTEM.md`（Pi 文档：**替换**默认系统提示；适配器始终显式 `--approve`，项目资源
     因此加载），把请求压进窗口。被测的是沙箱的写路径，不是提示词的措辞。
   - **窗口约 20 分钟一次、只持续几秒**：固定间隔重试必然错过（实测 6 次 × 2.5 分钟全落空）。
     改成先用 1 token 探针**等窗口**再立刻请求；健康 provider 首次探针即通过。上限
     `MTA_P9_WINDOW_MS`（默认 20 分钟），等不到仍报 `BLOCKED` 且 exit 2。
   早先这条写的是"未观察到"——那个判断在当天被实测取代。保留说明是因为**等待逻辑不是
   默认路径的代价，而是对共享配额的诚实建模**。
   另外记一件事：**棘轮改变了实现**。这道执行门本想写进 `durable-worker.ts`，但
   `max_file_lines` 的 baseline 是 901，加 13 行即违规，于是 `personaThinking` 被抽成
   `persona-thinking.ts`（914→879）。规则拦下的是增长，所以修法是拆，不是抬高 baseline。

## Reference Notes

`ref/teamagentx` is read-only. Verified findings that shaped this design:

- teamagentx web app is React + react-router + zustand + Socket.io + Radix/
  Tailwind (shadcn `components.json`); three-column layout: conversation list,
  chat area, side panel (agents / task-board / task-queue / history).
- teamagentx `LICENSE` is MIT (Copyright 2026 dbfu) — copying UI structure is
  permitted; attribution belongs in a NOTICE if we ship copied code.

- `mention_agents` structured handoff replaced regex/prose parsing — adopted.
- Handoff guardrails (fanout/depth/budget/revisit) are deterministic — adopted.
- Docs claim "任务卡" but the schema has no TaskCard; the real entities are
  TaskQueue / WorkbenchTask / Todo. We model `Task` explicitly instead.
- Doc/code drift exists upstream; treat `ref/` docs as narrative, not spec.
