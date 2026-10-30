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
