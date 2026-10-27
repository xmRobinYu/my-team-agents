# CONTEXT.md

Project context, vocabulary, and the decision log. Decisions here are
**append-only**: later entries amend earlier ones and never overwrite them.

## Vocabulary

| Term | Meaning | Status |
|---|---|---|
| Project | Owns one workspace (`.pi/`, AGENTS.md, git repo) | settled |
| Group | A collaboration **view** over a project | settled |
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
- Resume of the original Pi session is wired at the adapter level but **not
  proven end-to-end**: the `pi` binary is absent, so recovery falls back to a new
  Attempt built from the deterministic recovery snapshot (Q20/Q18).
- `busy_timeout` is required: separate processes hit SQLITE_BUSY without it.
**Gap**: no end-to-end Pi smoke; session resume is untested against real Pi.

### Q25 — Development-only mock runtime
**A**: a deterministic mock adapter exists for local verification. **R**: allows
queue, retry, handoff and UI verification without the `pi` binary.
- It never calls a model and never edits files; the UI must not present it as an
  agent result.
- `MTA_RUNTIME=mock` selects it; production mode uses Pi or CLI adapters.
**Gap**: mock success is not evidence that Pi integration works.

## Reference Notes

`ref/teamagentx` is read-only. Verified findings that shaped this design:

- `mention_agents` structured handoff replaced regex/prose parsing — adopted.
- Handoff guardrails (fanout/depth/budget/revisit) are deterministic — adopted.
- Docs claim "任务卡" but the schema has no TaskCard; the real entities are
  TaskQueue / WorkbenchTask / Todo. We model `Task` explicitly instead.
- Doc/code drift exists upstream; treat `ref/` docs as narrative, not spec.
