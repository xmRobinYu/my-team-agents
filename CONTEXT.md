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

## Reference Notes

`ref/teamagentx` is read-only. Verified findings that shaped this design:

- `mention_agents` structured handoff replaced regex/prose parsing — adopted.
- Handoff guardrails (fanout/depth/budget/revisit) are deterministic — adopted.
- Docs claim "任务卡" but the schema has no TaskCard; the real entities are
  TaskQueue / WorkbenchTask / Todo. We model `Task` explicitly instead.
- Doc/code drift exists upstream; treat `ref/` docs as narrative, not spec.
