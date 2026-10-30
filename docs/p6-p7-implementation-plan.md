# P6/P7 实施分析：持久队列与服务端 API / assistant-ui 接入

> **状态指引（2026-10-29）**：本文是落地**前**的差距分析快照，其「未提交 / 未装依赖 /
> 门禁不通过 / 不建议用 react-pi」等结论**已成历史**。当前 P6 与 P7a 已完成并通过门禁，
> UI 已全面改用 `@assistant-ui/react-pi`（经 `/api/pi` 投影，见 `CONTEXT.md` Q27）。
> 现状以 `docs/project-plan.md`、`docs/architecture.md` §6.5–6.6 与代码为准；本文保留作决策溯源。
>
> 本文是**分析文档**，不描述已完成的事实，也不替代代码。结论以仓库当前工作树为准。
> 决策依据：`CONTEXT.md` Q16（v1 队列为内存 FIFO）、Q18（任务级恢复）、Q19（SQLite +
> API/Worker 分离 + 单活跃 Worker）、Q20（保守工具恢复 + 事务化 outbox）、Q21（3 次
> Attempt、链式取消、120s/30s/10s/30s 超时族）、Q22（SSE + HTTP + 工作包）、Q23（P7a→P7b）。
> 新增文档需在 `docs/feishu-sync.json` 登记后才能 `just sync-docs`，登记前
> `just verify-docs` 会报 `managed doc not in manifest`。

## 0. 结论摘要

1. **P6 主体已在工作树中落地但未提交、且当前门禁不通过**：
   `packages/orchestrator/src/execution-store.ts`（548 行）已具备 SQLite 持久化、条件原子
   claim、fencing token、outbox 幂等、Attempt 上限与恢复快照；
   `packages/orchestrator/src/durable-worker.ts` 已具备租约心跳、空转超时、未知工具
   blocked、结构化结果校验。**但这些文件是 untracked，且当前门禁不通过**
   （runtime-pi 2 处 TS 错误 + 3 个测试失败），见 §1.4。
2. **P6 剩余缺口集中在语义而非管道**：会话续跑未接线、单活跃 Worker 未强制、
   取消宽限期缺失、恢复路径能复活已取消的链、fanout 护栏在持久路径失效、
   Dead Letter 无运营视图、schema 无版本化迁移。
3. **P7 骨架已超出"仅 API"**：`packages/server` 提供本机 loopback API 与两种 SSE。
   `packages/web` 在本分析期间（2026-10-28 00:00 之后）被实现出 `src/`：
   `api/client.ts`（HTTP + `EventSource`）、`chat/mapping.ts`（事件 → 会话折叠，纯函数，带测试）、
   `chat/conversation-store.ts`（`useExternalStoreRuntime` + `useSyncExternalStore`，只读）、
   `hooks/useWorkbenchData.ts`。**形态与 §3.4 推荐一致**：用 `@assistant-ui/react` 的
   external store，不引 `@assistant-ui/react-pi`，不启进程。
   **但依赖尚未安装**（`node_modules/@assistant-ui` 不存在，`pnpm-lock.yaml` 无该条目），
   这份 UI 代码目前**无法 typecheck / 构建**。
   服务端仍存在权威性问题：`workspacePath` 由客户端传入且未校验，`GET /api/tasks`
   无租户过滤，全局 SSE 只盯"最新创建的一条任务"会漏事件；UI 的 `FALLBACK_CATALOG`
   在 `/api/catalog` 不可用时把 `workspacePath` 留空要求手填，等于把 R8 暴露给使用者。
4. **不建议在 P7 使用 `@assistant-ui/react-pi` 作为生产运行时**：按仓库既有判断
   （`AGENTS.md` §Important Development Notes、`CONTEXT.md` Q8），react-pi 的 `agentDir`
   只能在 supervisor 构造时固定，且 supervisor 属于 UI 侧；把生产队列交给它，与 Q19
   「服务端是唯一权威、react-pi 不拥有生产队列」直接冲突。推荐 assistant-ui 的
   **external store runtime** 形态，接 SSE 只读投影。**此结论需在真正安装该包后，
   用其类型定义复核**（见附录 B-3）。

---

## 1. 现状差距表

### 1.1 已实现（工作树，未提交）

| 能力 | 落点 | 说明 |
|---|---|---|
| SQLite 持久任务队列 | `packages/orchestrator/src/execution-store.ts:114-196` | `chains` / `tasks` / `attempts` / `events` / `usage` / `outbox` 六表 + 索引；`WAL` + `foreign_keys` |
| 条件原子 claim + fencing | `execution-store.ts:375-398`、`:322-329` | `BEGIN IMMEDIATE` 内 SELECT+INSERT+UPDATE；所有归属写入经 `current()` 校验 `attempt.fencing_token` 与 `tasks.active_attempt_id` |
| 迟到写入拒绝 | `execution-store.ts:331-354` | 过期 Attempt 的 `appendEvent` 返回 `false`，不污染新 owner |
| 租约与心跳 | `execution-store.ts:400-408`、`durable-worker.ts:86-88` | 30s 租约，10s 续租（`leaseMs/3`，上限 10s） |
| Attempt 上限 3 次、Worker 重启不清零 | `execution-store.ts:380`、`:465-466`、`:487` | `batch_attempts` 持久化，claim 与失败/恢复判定都读它 |
| 任务级恢复快照 | `execution-store.ts:479-514` | 结构化快照：原 prompt、上次错误、最后助手消息、工具结局清单 |
| 未知工具结局 → blocked | `durable-worker.ts:48-57`、`:149-155` | 只读白名单（read/grep/glob/find/ls/handoff_to/submit_result），其余 pending 即 blocked |
| 人工确认后才重试 | `execution-store.ts:538-547`、`server/src/app.ts:99-112` | `POST /confirm` 要求 note，重置为 queued 并在快照写入 `humanConfirmedSideEffects` |
| 交接 outbox 去重 + 同事务提交 | `execution-store.ts:413-452` | 子任务、outbox、链预算、Task 终态同一事务；`UNIQUE(source_tool_call_id, target_member_id)` |
| 结构化结果校验 | `durable-worker.ts:37-46`、`:62-73` | outcome/summary/artifacts/remainingRisks 缺一即失败 |
| 链式取消 | `execution-store.ts:515-525` | 父取消 → 未完成后代置 cancelled，活跃者置 cancelling |
| API/Worker 进程分离 | `server/src/server.ts:9-23`、`server/src/worker.ts:8-33` | API 只读 + 发信号；Worker 轮询 250ms；取消经 DB 标志跨进程生效 |
| 结构化交接（声明式） | `orchestrator/src/handoff-intent.ts:45-93` | 只认 `tool_execution_start` 的 `handoff_to`，散文不解析 |
| 停滞看门狗 | `orchestrator/src/stall-watchdog.ts:21-65` | 注入时钟、`unref()`、事件驱动 ping |
| 每日自评估幂等 | `cost-report/src/parse.ts:41-100`、`cli.ts:88-110` | `since` 游标按 entry-id 增量 |
| 原有 dispatcher 闭环 | `orchestrator/src/dispatcher.ts:65-155` | settle 后派发、确定性护栏、`start()` 抛错降级 failed |
| UI 只读投影（实现中） | `packages/web/src/chat/conversation-store.ts:1-215` | `useExternalStoreRuntime` + `useSyncExternalStore`，线程内容完全由 Task/事件映射决定；未引 `react-pi` |
| 事件 → 会话折叠（纯函数） | `packages/web/src/chat/mapping.ts:96-201` 及 `mapping.test.ts` | Attempt 合并、文本合并、running 占位、cursor 计算；14 例测试 |
| 前端 API/SSE 客户端 | `packages/web/src/api/client.ts:37-165` | HTTP 操作 + 两种 `EventSource`（全局快照 / 单任务 after 游标）；路由仍是 `/api/*`，非 `/api/v1` |

### 1.2 部分实现（有形状，缺关键语义）

| 能力 | 现状 | 缺口 |
|---|---|---|
| 会话续跑 | `runtime-pi/src/adapter.ts:113-119` 已支持 `--session-dir/--session-id`；`runtime-core/src/adapter.ts:42-46` 有 `RunSession` | `durable-worker.ts:107-111` 从不传 `spec.session`；`tasks` 无 session 字段；无「session 文件是否存在」探测；恢复一律走快照重建 |
| 恢复快照 | 存 `tasks.recovery_snapshot`（`execution-store.ts:137`） | 每次 `recoverAttempt` 覆盖同一列（`:488-490`），不是"每 Attempt 不可变快照"；旧 Attempt 的证据会丢 |
| 取消 | 置 `chains.cancel_requested` + `tasks.cancelling` | 无 `cancel_requested_at`、无 30s 宽限期后的强制 orphan；`requestCancelChain` 返回的是事后 `COUNT(*)`（`:521-523`）而非本次 `changes`，重复取消会重复计数；Worker 侧仅靠 1s 轮询发现（`durable-worker.ts:122-125`） |
| 重试退避 | `execution-store.ts:467` | 固定 5s / 25s，无 jitter；无 `retry_after` 可见性 |
| 单活跃 Worker | 仅靠单进程 `working` 锁（`worker.ts:10-19`） | 进程间无互斥；两个 Worker 可在同一 workspace 并发跑不同任务 |
| Dead Letter | 3 次耗尽 → `tasks.status='failed'` | 无 `dead_letter_at` / 无运营查询 / 无 API |
| 事件分页 | `GET /api/tasks/:id/events` 返回数组（`app.ts:113-124`） | 默认 `limit=500`（`execution-store.ts:356`）且**无 hasMore/nextCursor**，超出部分被静默截断——违反"未知事件不可静默丢弃" |
| 全局事件流 | `app.ts:125-148` 1s 轮询 | 只比较 `listTasks(1)[0].updatedAt`（`:137`），即"最新创建"的那条；对旧任务状态变化不感知；`notify()` 只在 API 进程内的写操作触发，Worker 进程造成的状态迁移（running→succeeded 等）不会推给任何客户端，只能靠 1s 轮询间接发现 |
| 任务事件流 | `app.ts:149-181`，`id:` 用全局 `events.id` | 无 `Last-Event-ID` 头处理；无 `task.snapshot` 首帧；无慢消费者策略；无 `stream.reset` |
| 运行时缺失降级 | `dispatcher.ts:90-105` 的 try 包住 `await adapter.start(...)` | **实测不成立**：`PiAdapter.start()` 不抛错（`spawn()` 的错误异步到达），而是 `settled` 解析为 `failed` + `spawn pi ENOENT`。任务能降级，但同一路径产生**未处理的 Promise rejection**；`node --unhandled-rejections=strict` 下 Worker 直接 exit 1（实测）。另无 `runtime_missing` 错误码，重试 3 次才 failed，无法区分"缺二进制"与"模型失败" |
| 幂等创建 | `tasks.idempotency_key UNIQUE` + 先查后插（`:258-275`） | API 不强制/不返回复用标记；并发同 key 插入在第二个连接上会抛唯一约束，未转 409 |

### 1.3 缺失

| 能力 | 影响 |
|---|---|
| `packages/web` 可运行 | 检查时点（2026-10-28 00:1x）已有 `api/`、`chat/`、`components/`、`hooks/`、`lib/`，**但入口未接齐**：`index.html` 引用的 `/src/main.tsx` 不存在；依赖未安装，故 `just build`/`just typecheck` 覆盖不到它 |
| UI 断言与投影不变式 | `chat/mapping.test.ts` 已存在；但"未知事件必须显示为原始事件"、"断线重连按 cursor 幂等"等 §4.2 H 组场景尚未全部覆盖，且构建期"不得依赖 `react-pi`/`child_process`"没有自动检查 |
| 鉴权 / 租户与项目授权 / SSE 鉴权 / 审计 | P7b 全部；当前 `GET /api/tasks` 无过滤（`app.ts:54`） |
| 服务端解析 `workspacePath` | 客户端可指定任意目录（`app.ts:56-68`），本机即为任意目录执行风险 |
| schema 版本化迁移 | 仅 `CREATE TABLE IF NOT EXISTS`（`:114-196`），加列不会作用到既有 DB |
| `attempts` 上的恢复快照 / session 字段 / 结束原因 | 无法审计"这次尝试为何结束" |
| outbox 的链作用域与状态机 | `UNIQUE(source_tool_call_id, target_member_id)` 跨链冲突（见 §4.1 R2） |
| Worker 注册表 | 无法表达"某 workspace 当前由谁持有" |
| 事件去重键 | `appendEvent` 用 `MAX(seq)+1`（`:336-338`），上游重投会生成新行 → 重复事件 |
| 结构化错误码 | 全部是 `{error: string}` |
| 请求/响应 schema 校验、OpenAPI | 无 Fastify JSON Schema，字段拼写错误只在下游炸 |
| 限流、CORS、CSRF | 无 |

### 1.4 当前门禁为红（必须作为阶段 0 修复）

实测（`2026-10-27`，`node v22.22.1`）：

```text
$ npx tsc -p packages/runtime-pi/tsconfig.json --noEmit
packages/runtime-pi/src/adapter.ts(129,26): error TS2554: Expected 3 arguments, but got 2.
packages/runtime-pi/src/adapter.ts(274,7): error TS2304: Cannot find name 'holder'.

$ npx vitest run
Test Files  2 failed | 11 passed (13)
Tests       3 failed | 91 passed (94)
  runtime-pi/src/settle.test.ts > "does not resolve settled on agent_end in long-lived RPC mode" (holder is not defined)
  runtime-pi/src/settle.test.ts > "reports a failed result when Pi exits before agent_settled" (holder is not defined)
  orchestrator/src/recovery.test.ts > "cancels unfinished descendants without reviving a cancelled chain on manual retry" (queued != cancelled)
```

根因（读码确认，非猜测）：

- `adapter.ts:129` 仍以 2 参调用 `this.settle(...)`，而 `:258-262` 的签名已改为 3 参
  并引入 `holder`，**`holder` 从未定义**——说明这是一次未完成的半提交重构。
- `store.retryTask()`（`execution-store.ts:528-536`）对 `cancelled` 任务无条件置
  `queued`，不检查 `chains.cancel_requested`；`claimNext` 会跳过它（`:381`），
  于是任务永久停在 `queued` 僵尸态。测试表达的语义是对的，实现是错的。

> 先修门禁再谈增量：在红色基线上叠加 P6/P7 无法区分"新引入"与"既有"失败。

### 1.5 顺带发现的语义缺陷（影响 §2/§4 设计）

| 编号 | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| D1 | 持久路径的 fanout 护栏失效：逐个 target 调 `evaluateHandoff(..., [memberId])`，数组长度恒为 1 | `durable-worker.ts:180-181` | 一次声明 100 个 target 也能全过；与 `dispatcher.ts:130-134`（按整组判定）行为不一致 |
| D2 | 取消后的 `completeSuccess` 仍创建子任务 | `execution-store.ts:423-447` | 任务被置 cancelled，但 handoff 循环照跑 → 子任务 `queued` 且因链已取消永远不被 claim，成为僵尸 |
| D3 | `recoverAttempt` 不检查链取消标志 | `execution-store.ts:479-493` | 已取消任务在租约过期后被改成 `retry_wait`/`blocked`，与"取消是终态"冲突 |
| D4 | 空转超时路径不判未知工具 | `durable-worker.ts:145-148` | 超时前若有未完成的非只读工具，会被**自动重试**而不是 blocked，违反 Q20 |
| D5 | 交接幂等键无链作用域 | `execution-store.ts:194`、`:430-432` | 不同链复用同一 `toolCallId` 时被静默去重到别的链；`tasks.idempotency_key` 全局 UNIQUE 加剧此问题 |
| D6 | `claimNext` 不校验 `UPDATE ... changes === 1` | `execution-store.ts:392-394` | 当前靠 `BEGIN IMMEDIATE` 兜住；一旦改为乐观并发或加 retry 包装就会漏 |
| D7 | 使用量以 `MAX()` 合并 | `execution-store.ts:343-350` | 若上游是"每消息 usage"（`cost-report` 的假设），同 attempt 多消息会**少计**；若为累计值，则 `MAX` 正确。两种语义混用且无测试钉住 |
| D8 | 事件无上游 id | `runtime-core/src/events.ts:49-73` | 重投/重放无法去重；`MAX(seq)+1` 会照样追加 |
| D9 | `GET /api/tasks/:id` 内嵌 `events` 静默截断 500 | `app.ts:79` + `execution-store.ts:356` | UI 首屏可能少事件且无法察觉 |
| D10 | 全局 SSE 只看最新一条任务的 `updatedAt` | `app.ts:137` | 旧任务的创建/取消/重试不推送 |
| D11 | ENOENT 产生未处理的 Promise rejection | `runtime-pi/src/adapter.ts:230`（`child.on("error", fail)` 拒绝 `done`）→ `start()` 不再 await/链接 `done` | **本次未提交的 settle 重构引入的回归**：HEAD 版 `settle` 以 `await done` 消费该 Promise，rejection 不逃逸；重构后 `done` 无人 await，缺 `pi` 时 `settled` 仍能报 `failed`，但 `done` 的 rejection 逃逸，`--unhandled-rejections=strict` 下进程 exit 1（实测），违反"运行时缺失不得崩溃调用方"。与 §1.4 的 `holder` 半成品重构是同一处，阶段 0 一并修复 |


## 2. 数据模型改造方案

### 2.1 状态机

现状：`domain/src/entities.ts:56` 是五态 `queued|running|settled|failed|aborted`，
`execution-store.ts:5-13` 是八态 `queued|running|retry_wait|blocked|succeeded|failed|cancelling|cancelled`。
**两套并存且无引用关系**（`domain.Task` 未被 store 使用）。建议以 store 八态为准，
`domain` 侧改为引用同一类型，禁止再次分叉。

```text
queued ──claim──▶ running ──ok──────────────▶ succeeded        (终态)
  │                  │──retryable fail──────▶ retry_wait ──claim──▶ running
  │                  │──unknown tool────────▶ blocked
  │                  │──cancel──────────────▶ cancelling ──ack/宽限到期──▶ cancelled
  │                  └──3 次耗尽────────────▶ failed
  ├──chain cancel───────────────────────────▶ cancelled
  └──(blocked) ──人工 confirm: completed───▶ succeeded  (副作用已完成，不再重跑)
             ├──人工 confirm: retry────────▶ queued
             └──人工 confirm: abandon───────▶ failed
failed / cancelled ──manual retry(新 batch)──▶ queued   (仅当链未取消)
succeeded ──不可重试；需要再跑则新建 Task，带 parentTaskId + 新 chain 或同链新分支
```

关键新增：**`blocked` 的人工决策必须是结构化的三选一**（`completed` / `retry` / `abandon`），
不是自由文本 note；当前 `confirmBlocked` 只实现"retry"。
Dead Letter 不是状态（Q21 明确），是查询视图：`status='failed' AND batch_attempts>=max_attempts`。

### 2.2 表结构建议

沿用现有六表，**新增 2 表（`workers`、`audit_log`）+ 重建 1 表（`outbox_v2`）+ 扩列**。以下 DDL 为建议形态，落地时按迁移脚本执行。

#### tasks（扩列）

```sql
ALTER TABLE tasks ADD COLUMN input_json        TEXT;      -- 工作包：prompt/images/fileRefs
ALTER TABLE tasks ADD COLUMN run_spec_json     TEXT;      -- 不可变：重建本次执行所需的一切
ALTER TABLE tasks ADD COLUMN max_attempts      INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN priority          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN timeout_ms        INTEGER;   -- 硬超时；NULL = 只靠 idle
ALTER TABLE tasks ADD COLUMN idle_timeout_ms   INTEGER;   -- 默认 120000
ALTER TABLE tasks ADD COLUMN session_id        TEXT;      -- 最大努力续跑的目标会话
ALTER TABLE tasks ADD COLUMN session_dir       TEXT;
ALTER TABLE tasks ADD COLUMN resume_supported  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN blocked_reason    TEXT;      -- unknown_tool_outcome | ...
ALTER TABLE tasks ADD COLUMN blocked_at        INTEGER;
ALTER TABLE tasks ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE tasks ADD COLUMN cancelled_by      TEXT;
ALTER TABLE tasks ADD COLUMN dead_letter_at    INTEGER;
ALTER TABLE tasks ADD COLUMN last_error_code   TEXT;
ALTER TABLE tasks ADD COLUMN version           INTEGER NOT NULL DEFAULT 0;  -- 乐观并发
ALTER TABLE tasks ADD COLUMN created_by        TEXT;
```

`attempts_used` 即现有 `batch_attempts`（**不改名**，避免无收益的迁移面）；
`batch` 表示"第几轮人工重试"，两者语义保留并在文档中固定。

#### attempts（扩列：让每次尝试自证）

```sql
ALTER TABLE attempts ADD COLUMN resume_from_attempt_id TEXT;
ALTER TABLE attempts ADD COLUMN resumed_session_id     TEXT;
ALTER TABLE attempts ADD COLUMN recovery_snapshot      TEXT;   -- 本 Attempt 不可变快照
ALTER TABLE attempts ADD COLUMN worker_pid             INTEGER;
ALTER TABLE attempts ADD COLUMN host                   TEXT;
ALTER TABLE attempts ADD COLUMN last_event_at          INTEGER;
ALTER TABLE attempts ADD COLUMN ended_at               INTEGER;
ALTER TABLE attempts ADD COLUMN exit_reason            TEXT;   -- completed|failed|orphaned|cancelled|blocked
ALTER TABLE attempts ADD COLUMN error_code             TEXT;
```

`exit_reason` 与 `status` 分离：`status` 是机械状态，`exit_reason` 是诊断原因
（`runtime_missing` / `idle_timeout` / `lease_lost` / `unknown_tool_outcome` /
`invalid_result` / `superseded` / `cancel_requested`）。
#### events（加去重与保留策略）

```sql
ALTER TABLE events ADD COLUMN upstream_event_id TEXT;   -- 上游给什么记什么，可为 NULL
CREATE UNIQUE INDEX IF NOT EXISTS events_upstream
  ON events(attempt_id, upstream_event_id) WHERE upstream_event_id IS NOT NULL;
```

`CanonicalEvent` 需加 `upstreamEventId?: string`（`runtime-core/src/events.ts`），
Pi 适配器在 `streamEvents` 里透传 `record.id`。未知事件仍走 `type:"unknown"` + `rawType`，
**不加白名单过滤**。

SSE 的 `id:` 继续用全局 `events.id`（AUTOINCREMENT 单调、跨重启稳定）；
`attempt_sequence` 只用于单次尝试内排序与展示。两者都暴露，但**断点续传只认 `events.id`**。

#### outbox（加链作用域与状态机）

```sql
-- 建议整表重建（SQLite 改唯一约束需 12 步）
CREATE TABLE outbox_v2 (
  id                 TEXT PRIMARY KEY,
  chain_id           TEXT NOT NULL REFERENCES chains(id),
  source_task_id     TEXT NOT NULL REFERENCES tasks(id),
  source_attempt_id  TEXT NOT NULL REFERENCES attempts(id),
  source_tool_call_id TEXT NOT NULL,
  target_member_id   TEXT NOT NULL,
  child_task_id      TEXT NOT NULL REFERENCES tasks(id),
  reason             TEXT NOT NULL,
  work_package       TEXT NOT NULL,          -- 交接工作包原文，便于审计与重放
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|cancelled
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  delivered_at       INTEGER,
  UNIQUE(chain_id, source_tool_call_id, target_member_id)
);
```

> 这是 D5 的修法：幂等域从"全局 toolCallId"收敛到"链内 toolCallId"。

#### workers（新增：单活跃 Worker 的持久依据）

```sql
CREATE TABLE IF NOT EXISTS workers (
  id               TEXT PRIMARY KEY,
  workspace_path   TEXT NOT NULL UNIQUE,   -- 互斥粒度 = 项目工作区
  pid              INTEGER NOT NULL,
  started_at       INTEGER NOT NULL,
  heartbeat_at     INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL
```

claim 前置：`INSERT ... ON CONFLICT(workspace_path) DO UPDATE SET ... WHERE lease_expires_at < now`
拿不到即退出（不抢）。这明确表达"单活跃 Worker 是进程级约束，不是分布式调度"（Q19）。

#### audit_log（P7b，新增）

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  tenant_id  TEXT,
  project_id TEXT,
  target_id  TEXT,
  detail     TEXT
);
```

#### schema 版本

```sql
PRAGMA user_version;   -- 0 → 1 → 2 ...
```

### 2.3 写入路径不变式（必须由 store 单点保证）

| 不变式 | 实现要求 |
|---|---|
| 无执行在事务内 | `ExecutionStore` 只做 SQL；`adapter.start()` 及事件消费在事务外（现状已满足，`durable-worker.ts:95-205`） |
| 终态 + 交接 + outbox 同事务 | `completeSuccess` 一处提交（现状已满足）；**取消时不得进入交接循环**（修 D2） |
| Attempt 上限持久 | 判定只读 `tasks.batch_attempts`，不得用进程内计数器 |
| 取消是链级事实 | `claimNext` / `recoverAttempt` / `retryTask` / `completeSuccess` 四处都必须读 `chains.cancel_requested`（修 D2/D3/红测） |
| 未知结局不自动重放 | idle 超时、租约过期、进程崩溃三条路径都先算 `unknownHighRiskTools`（修 D4） |
| 事件只追加 | `events` 无 UPDATE/DELETE；去重靠唯一索引，不靠覆盖 |

### 2.4 迁移方式

1. **一次性基线化**：现有 `CREATE TABLE IF NOT EXISTS` 保留为 `migration 0`（空库直建），
   并写入 `PRAGMA user_version = 1`。
2. **顺序迁移函数**：`migrations: Array<(db) => void>`，每步 `BEGIN IMMEDIATE` 内执行，
   成功后 `user_version = n`。禁止跳步。
3. **只做增量**：`ALTER TABLE ADD COLUMN` 一律带 `NOT NULL DEFAULT`；改唯一约束/删列
   用"建新表 → 复制 → 改名"（SQLite 官方 12 步），并在复制前 `CREATE TABLE _bak` 同库备份。
4. **启动即迁移，失败即退出**：迁移失败不得以半迁移状态继续服务；打印 `user_version`
   与实际表结构摘要。
5. **并发**：`busy_timeout` 必须设置。实测跨进程时 `new DatabaseSync(f)` 默认立即
   `database is locked`；`PRAGMA busy_timeout=5000` 可让第二个进程等待并成功
   （已在本机用两个 node 进程验证：等待 1555ms 后写入成功）。开启 WAL 后仍必须设置它。
6. **`node:sqlite` 仍是 experimental**（Node 22 会打印 `ExperimentalWarning`）。
   P6/P7a 可继续用（不引新依赖），P7b 前复核：若升级 Node 导致行为变化，
   退回 `better-sqlite3` 需要一次依赖决策，不要临时改。

### 2.5 与 domain 实体对齐

- `domain/src/entities.ts:56` 的 `TaskStatus` 删除或改为从 orchestrator 重导出，
  避免两套状态机。
- `domain.Task` 增加 `chainId` / `parentTaskId` / `attemptsUsed` / `status` 的同一枚举，
  并标注"运行时权威在 `tasks` 表，domain 只做类型"。
- `Handoff`（`entities.ts:70-77`）目前无 `sourceToolCallId`，与 outbox 的幂等键脱节；
  建议补 `sourceToolCallId`，使领域对象与持久化记录可对账。

---

## 3. 接口契约

### 3.1 路由（前缀 `/api/v1`）

| 方法 | 路径 | 语义 | 成功 | 主要错误 |
|---|---|---|---|---|
| GET | `/health` | 存活 + 模式（`development`/`team`） | 200 | — |
| GET | `/capabilities` | 服务端能力：`sessionResume`、`maxAttempts`、`sse`、`auth` | 200 | — |
| GET | `/catalog` | 租户/项目/成员（**服务端配置，非客户端传入**） | 200 | 401/403（P7b） |
| POST | `/tasks` | 创建任务 | 201 + Task | 400 `invalid_request`、409 `idempotency_conflict` |
| GET | `/tasks` | 列表：`tenantId`、`projectId`、`status`、`cursor`、`limit` | 200 `{items,nextCursor}` | 400 |
| GET | `/tasks/:id` | 任务 + attempts 摘要 + `eventCursor`（**不内嵌全量事件**） | 200 | 404 |
| GET | `/tasks/:id/events` | 事件分页：`after`、`limit` | 200 `{items,nextCursor,hasMore}` | 404、410 `cursor_expired` |
| GET | `/tasks/:id/stream` | SSE：任务事件 | 200 `text/event-stream` | 404、410 |
| GET | `/tasks/stream` | SSE：任务状态汇总（替代现 `/api/events`） | 200 | — |
| POST | `/tasks/:id/cancel` | 链级取消 | 202 `{affected,chainId,attemptId}` | 404、409 `invalid_state` |
| POST | `/tasks/:id/retry` | 新 batch 重试 | 202 + Task | 404、409 `attempts_exhausted`/`chain_cancelled` |
| POST | `/tasks/:id/confirm` | blocked 决策：`decision` 取 `completed` / `retry` / `abandon`，附 `note` | 200 + Task | 404、409 `invalid_state` |
| GET | `/dead-letter` | 耗尽 Attempt 的任务视图 | 200 `{items}` | — |
| GET | `/audit` | P7b | 200 | 403 |

创建任务请求体（`workspacePath` **不在其中**）：

```json
{
  "projectId": "my-team-agents",
  "memberId": "pi-agent",
  "input": {
    "prompt": "把 P6 的迁移脚本补齐",
    "images": [],
    "fileRefs": [{ "path": "docs/architecture.md" }]
  },
  "model": "…",
  "priority": 0,
  "maxAttempts": 3,
  "clientRequestId": "ui-7f3c…"
}
```

- 幂等：`Idempotency-Key` 头优先，缺失时用 `clientRequestId`；命中已存在则返回 **200 +
  原 Task** 并带 `Idempotent-Replay: true`，而不是 201。
- `workspacePath` 由服务端按 `projectId` 从项目注册表解析；解析不到 → 400
  `project_not_found`。**这是 P7b 之前就要改的**，否则 loopback 也可能跑任意目录。
- 状态变更类接口带 `If-Match: <task.version>`（可选但推荐），不匹配 → 409
  `stale_version`，避免"UI 以为在取消，服务端已 succeeded"。

### 3.2 SSE 契约

帧格式（`event: task.event` 为增量，`task.state` 为投影，`task.snapshot` 为首帧）：

```text
retry: 3000

id: 10421
event: task.snapshot
data: {"task":{"id":"task-…","status":"running","version":4,"attemptsUsed":1},
       "attempts":[…],"nextCursor":10422}

id: 10422
event: task.event
data: {"taskId":"task-…","attemptId":"attempt-…","seq":17,
       "event":{"type":"tool_execution_start","toolName":"write","toolCallId":"c1",
                "timestamp":"2026-10-27T09:00:00.000Z"},
       "at":"2026-10-27T09:00:00.010Z"}

event: task.state
data: {"taskId":"task-…","status":"blocked","blockedReason":"unknown_tool_outcome",
       "version":9,"updatedAt":…}

event: stream.reset
data: {"reason":"cursor_expired","oldestAvailable":9800}

: heartbeat
```

规则：

1. **断点续传**：客户端可发 `Last-Event-ID`（浏览器 `EventSource` 自动带），也可用
   `?after=`。两者同时存在时以 `Last-Event-ID` 为准，并在响应头回 `X-Event-Cursor`。
2. **未知事件不丢**：`event.type` 不在客户端已知集合时，UI 必须落到"原始事件"折叠项，
   显示 `rawType`。服务端不得过滤、不得合并。
3. **首帧必发 snapshot**：避免 UI 先连流再补一次 `GET /tasks/:id` 的竞态。
4. **慢消费者**：`res.write()` 返回 `false` 时暂停拉取，`drain` 后继续；积压超过阈值
   主动断开并让客户端用 cursor 重连（**断开而不是丢帧**）。
5. **心跳**：15s 一行注释 `: heartbeat`；`retry: 3000`。
6. **多副本**：SSE 连接是进程本地的；P7b 若多副本，需要共享总线（Postgres
   `LISTEN/NOTIFY`）或粘性会话。**SQLite + 多 API 副本不在 P7 承诺范围内**，写入 §4。

### 3.3 错误码

统一形状：

```json
{ "error": { "code": "invalid_state", "message": "…", "details": {}, "requestId": "req-…" } }
```

| code | HTTP | 场景 |
|---|---|---|
| `invalid_request` | 400 | body/schema 校验失败 |
| `unauthorized` | 401 | 未登录 / 令牌失效（P7b） |
| `forbidden` | 403 | 跨租户或跨项目访问（P7b） |
| `not_found` | 404 | task/project/member 不存在 |
| `conflict` | 409 | 通用状态冲突 |
| `idempotency_conflict` | 409 | 同 key 不同 body |
| `stale_version` | 409 | `If-Match` 不匹配 |
| `invalid_state` | 409 | 对 `succeeded` 取消、对 `queued` confirm |
| `chain_cancelled` | 409 | 在已取消链上重试 |
| `attempts_exhausted` | 409 | `batch_attempts >= max_attempts` 且非人工确认 |
| `cursor_expired` | 410 | `after` 早于保留下界（DB 被替换/裁剪） |
| `workspace_unavailable` | 422 | 工作区不存在或无权限 |
| `runtime_missing` | 422 | 适配器二进制缺失（**创建时预检，而不是跑 3 次才失败**） |
| `rate_limited` | 429 | P7b |
| `internal` | 500 | 兜底；必须带 `requestId` 便于对日志 |

### 3.4 assistant-ui 如何"只做展示"

**硬边界（写入 lint/评审清单）**：

- `packages/web` **不得依赖** `@assistant-ui/react-pi`，不得 `spawn`/`exec` 任何进程，
  不得读取 `~/.pi`、`.pi/`、会话 JSONL。
- 不得在浏览器侧保存"权威状态"：所有 `status`/`attempt`/`cost` 只能来自
  `GET /tasks/:id` 或 SSE。本地 store 是**投影**，不是事实。
- 一次"用户发言"= `POST /tasks` 创建一个 Task；**不是**向运行中的 Pi 推 prompt。
  这是与 react-pi 语义最大的差别，也是 Q19 的直接推论。

**推荐形态**：assistant-ui 的 external store 运行时（`useExternalStoreRuntime` 一类
的"外部状态源"接法），把服务端事件映射为 `ThreadMessage`：

| 服务端 | UI 投影 |
|---|---|
| `task.status` | 线程状态徽标（`running` / `retry_wait` / `blocked` / `cancelled` …） |
| `message_start/update/end` | 一条助手消息（`update` 追加、`end` 定稿） |
| `tool_execution_start/end` | 工具调用卡片（名称、args 摘要、error 标记） |
| `task.event` 中 `type:"unknown"` | 原始事件折叠项 + `rawType`，不可隐藏 |
| `blocked` + `blockedReason` | 三选一确认面板 → `POST /confirm` |
| `attempts[]` | "第 N 次尝试"分隔条；orphaned 尝试显示为"已中断" |
| `usage` | 只读成本摘要，标注 `billable`/`retry-waste` |

> 具体 hook 名以安装后的 `@assistant-ui/react` 类型定义为准；本文不锁定 API 名称，
> 只锁定"外部状态源 + 只读投影"这一形态。落地第一步是 `pnpm add` 后在
> `packages/web/src/__typecheck__` 里钉住实际导出。

**客户端行为约束**：

- 断线重连用 `Last-Event-ID`；重连后**先**渲染 `task.snapshot`，**再**应用增量，
  按 `id` 幂等（重复 id 丢弃，乱序 id 缓冲）。
- 乐观消息只存在于本地 `pending` 列表，key 为 `clientRequestId`；收到 201/200 后用
  **服务端返回的 taskId** 替换，不允许客户端生成 taskId。
- "重试"按钮只在服务端 `status ∈ {failed, blocked, cancelled}` 且 `!chainCancelled`
  时可用；点击后**不做本地状态跳跃**，等 SSE `task.state`。
- 禁止客户端自动重发 `POST /tasks`（除同一 `Idempotency-Key` 的手动重试）。

### 3.5 P7a / P7b 分界

| 项 | P7a（本机验收） | P7b（团队部署） |
|---|---|---|
| 绑定地址 | `127.0.0.1`（现状 `server.ts:23`） | 反代 + TLS |
| UI 标识 | 顶部常驻"开发模式：无登录、无租户隔离" | 真实身份 |
| 鉴权 | 无 | 会话 cookie（SSE 用 cookie，因为 `EventSource` 不能设头）+ CSRF |
| 授权 | 无 | 租户/项目级：列表、详情、取消、重试、confirm 逐项校验 |
| workspacePath | 服务端从静态 catalog 解析 | 从 DB 项目表解析 + 目录白名单 |
| 审计 | 无 | `audit_log` 全操作 |
| SSE | 允许无鉴权 | 连接时鉴权 + 断开时审计 |
| 限流 | 无 | 创建/流连接分别限流 |

**P7a 的验收不得被引用为 P7b 的证据**（Q23）。文档、README、UI 三处都要写清。

---

## 4. 风险与验收

### 4.1 风险登记

| 编号 | 风险 | 触发条件 | 现有防线 | 需补 |
|---|---|---|---|---|
| R1 | 重复执行（同一 Attempt 双跑） | 租约过期但旧进程仍活着；时钟回拨 | fencing token 拒绝迟到**写入**（`execution-store.ts:322-329`） | 30s 取消宽限 + 强制 orphan；`worker_pid`/`host` 记录；不接受"租约过期=进程已死" |
| R2 | 交接重复 | 同一次尝试重放；不同链复用 `toolCallId` | outbox UNIQUE + 子任务 idempotencyKey | 幂等域改 `(chain_id, tool_call_id, member_id)`（D5）；outbox 状态机 |
| R3 | Worker 双花 | 两个 Worker 进程同时 claim 同一 workspace | `BEGIN IMMEDIATE` 串行化 + `changes` 未校验 | `workers` 表按 workspace 互斥 + `changes===1` 断言（D6） |
| R4 | 成本重复计费 | 重试重跑；事件重投 | `usage` 主键 `(attempt_id, provider, model)` + `MAX` | 明确 usage 语义（累计 or 单条）并加测试钉住（D7）；报告区分 `spentTotal` 与 `settledTaskCost`；重试浪费单独一列 |
| R5 | UI 状态与服务端不一致 | SSE 丢帧、重连、乱序、浏览器挂起 | 无 | snapshot 首帧 + `id` 幂等重放 + `version` 单调校验；不一致时强制 `GET` 重同步 |
| R6 | 取消后仍产生副作用 | 协作式取消，进程不响应 | 1s 轮询 `cancel_requested` | 宽限期后强制 orphan + 子任务不创建（D2）；UI 文案明确"取消是请求，不是外部保证" |
| R7 | 未知工具结局被自动重试 | 空转超时（D4）、租约过期 | 租约路径已 blocked | 三条路径统一走 `unknownHighRiskTools` |
| R8 | 任意目录执行 | 客户端传 `workspacePath` | 无 | 服务端解析 + 白名单；P7a 也不放行 |
| R9 | 事件静默截断 | 500 条上限、无 hasMore（D9） | 无 | 分页游标 + `hasMore`；SSE 断流而非丢帧 |
| R10 | schema 漂移 | 无迁移，加列不生效 | `IF NOT EXISTS` | `user_version` + 顺序迁移 |
| R11 | 跨进程 SQLITE_BUSY | API 与 Worker 同时写 | WAL | 每连接 `PRAGMA busy_timeout=5000` + `SQLITE_BUSY` 有界重试；实测默认即报 locked |
| R12 | `node:sqlite` 实验性 | Node 升级 | 无 | 锁定 Node 版本；升级前跑全套崩溃/恢复测试 |
| R13 | 运行时缺失导致进程崩溃 | `pi` 未安装 / PATH 不含二进制 | 无（`settled` 报 failed，但 rejection 逃逸） | 修 D11：把 `done` 的 rejection 并入 `settled` 或显式 `catch`；加 F10 回归测试 |
| R14 | 多 API 副本 | 横向扩容 | 无 | 明确 P7 不承诺；写进 `/capabilities` |
| R15 | UI 代码在门禁外 | `pnpm-lock.yaml` 无 `packages/web` importer；根 `build`/`typecheck` 走 `pnpm -r`，只覆盖 workspace 依赖已安装的包 | 无 | 生成 importer 并把 web 纳入 CI；否则 UI 编译错误在 `just check` 中不可见（当前 `packages/web` 无 `main.tsx`，但门禁为绿也发现不了） |

### 4.2 必须新增的测试用例

> 检查时点基线：`npx vitest run` = 94 例 / 13 文件（2 文件、3 例失败，见 §1.4）。
> 与 P6 直接相关的是 `execution-store.test.ts`（10 例）+ `recovery.test.ts`（3 例）；
> UI 投影已有 `mapping.test.ts`（14 例）。下列按"能在无 `pi` 环境下跑"设计，
> 文件名是建议值，**覆盖优先于命名**。

**A. 持久化与崩溃（`recovery.test.ts` / `crash.test.ts`）**

| # | 用例 | 断言 |
|---|---|---|
| A1 | 落盘后重开 DB，`queued` 任务仍可 claim | 已有，保留 |
| A2 | 运行中 SIGKILL Worker 子进程，重启后任务完成 | 只有一个 `succeeded`；旧 attempt `orphaned` |
| A3 | 崩溃点在"工具已执行、事件未落库" | 任务进 `blocked`，`blockedReason=unknown_tool_outcome`，不自动重试 |
| A4 | Worker 连续重启 3 次 | `attempts` 恰好 3 行，第 4 次 claim 返回 null，任务 `failed` + `dead_letter_at` 非空；**重启不清零** |
| A5 | 崩溃在"子任务已建、outbox 未写"（模拟事务回滚） | 无孤儿子任务（同事务保证） |
| A6 | 事件重投（同 `upstream_event_id` 两次） | `events` 只 1 行；usage 不翻倍 |
| A7 | 会话续跑：session 文件存在且 capability 为真 | `spec.session.sessionId` 透传到 adapter，argv 含 `--session-id` |
| A8 | 会话续跑回退：session 文件缺失 | 走 `recoverySnapshot` 重建，不报错，不重复副作用 |

**B. 租约与并发（`lease.test.ts` / `concurrency.test.ts`）**

| # | 用例 | 断言 |
|---|---|---|
| B1 | 过期租约后旧 attempt 写入 | 返回 `false`，新 attempt 状态不被覆盖（已有，保留） |
| B2 | 两个 Worker 进程并发 claim 20 个任务 | 恰好 20 个 attempt，每任务 1 个 |
| B3 | 同一 workspace 起两个 Worker | 第二个拿不到 workers 租约，`runOnce()` 恒 false |
| B4 | 心跳续租失败（模拟 DB 被另一 owner 更新） | 当前 attempt 主动取消并记 `lease_lost` |
| B5 | 两个进程同时写，注入 200ms 持锁 | 有 `busy_timeout` 时不抛错；无则抛 `SQLITE_BUSY`（回归护栏） |

**C. 重试与取消（`retry-cancel.test.ts`）**

| # | 用例 | 断言 |
|---|---|---|
| C1 | 失败 → retry_wait → 第 2 次成功 | attempts=2，`batch_attempts=2` |
| C2 | 退避带 jitter | 两次调度间隔落在 `[base, base*1.5]` 且不相等 |
| C3 | 父取消 | 后代 `cancelled`，`affected` 等于本次 `changes`（重复取消返回 0） |
| C4 | 取消后 `completeSuccess` | **不创建子任务**（D2） |
| C5 | 已取消链上 `retryTask` | 返回 false，状态仍 `cancelled`（当前红测） |
| C6 | 已取消任务的租约过期 | 仍 `cancelled`，不回 `retry_wait`（D3） |
| C7 | 取消宽限期到期 | attempt 强制 `orphaned`，`exit_reason=cancel_requested` |
| C8 | `blocked` 三选一 | `completed`（人工确认副作用已完成，不再重跑）→ 依据备注判 `succeeded`；`retry`（确认需重做）→ `queued`；`abandon`（放弃）→ `failed`；三种都写审计 |

**X. 交接去重（`handoff-durable.test.ts`）**——编号用 X 以避免与缺陷 D1–D11 混淆。

| # | 用例 | 断言 |
|---|---|---|
| X1 | 同一 completion 提交两次 | 1 个子任务，1 条 outbox |
| X2 | 同一 toolCallId，不同链 | **两个**子任务（验证缺陷 D5 的修法） |
| X3 | 一次声明 21 个 target | 整组被拒（缺陷 D1，fanout 护栏） |
| X4 | 预算耗尽 | 子任务不创建，记录 `rejected` 原因，不静默 |
| X5 | 同一 target 被两个成员分别交接 | 2 个子任务（幂等键含 source） |

**E. 成本（`usage.test.ts`）**

| # | 用例 | 断言 |
|---|---|---|
| E1 | 同一 attempt 两条累计 usage | 取最大值，不累加 |
| E2 | 同一 attempt 两条单条 usage | 累加（明确语义后二选一被钉死） |
| E3 | 重试 3 次 | `spentTotal` = 三次之和；`settledTaskCost` = 最终 attempt；差值单列 `retryWaste` |
| E4 | 事件重投 | usage 不翻倍 |

**F. API（`app.test.ts` 扩）**

| # | 用例 | 断言 |
|---|---|---|
| F1 | 同 `Idempotency-Key` 两次 | 200 + `Idempotent-Replay: true`，同 id |
| F2 | 同 key 不同 body | 409 `idempotency_conflict` |
| F3 | 客户端传 `workspacePath` | 被忽略；实际取项目注册表 |
| F4 | 未知项目 | 400 `project_not_found` |
| F5 | 事件分页 | `hasMore` 正确；`nextCursor` 可续；总数不丢 |
| F6 | 对 `succeeded` 取消 | 409 `invalid_state` |
| F7 | `If-Match` 过期 | 409 `stale_version` |
| F8 | 错误形状 | 每个错误都有 `code`/`message`/`requestId` |
| F9 | 无 `pi` 二进制 | `POST /tasks` 预检 422 `runtime_missing`（或明确降级策略） |
| F10 | 缺 `pi` 时无未处理 rejection | 在 `process.on("unhandledRejection")` 之下跑 `worker.runOnce()`；断言 0 次触发，任务进 `retry_wait`/`failed`，错误码 `runtime_missing`（D11 回归护栏） |

**G. SSE（`stream.test.ts`，用 `app.listen({port:0})` + `fetch`）**

| # | 用例 | 断言 |
|---|---|---|
| G1 | 首帧 `task.snapshot` | 含 task + attempts + `nextCursor` |
| G2 | `Last-Event-ID` 续传 | 只收到 id > 该值的事件 |
| G3 | `?after=` 与头同时存在 | 头优先 |
| G4 | 未知事件 | 原样下发，`type:"unknown"` 保留 `rawType` |
| G5 | 慢消费者 | 断开而非丢帧；重连后事件完整 |
| G6 | 全局流 | 旧任务状态变化也推送（D10） |
| G7 | 心跳 | 15s 内有注释行 |

**H. UI 投影（纯函数，无需浏览器）**

> `chat/mapping.test.ts` 已有 14 例：文本合并（累积/增量）、Attempt 合并规则、
> running 占位、失败后 incomplete 标记、排序与 `transcriptCursor`。H1–H3 属补强，H4–H6 尚缺。

| # | 用例 | 断言 | 现状 |
|---|---|---|---|
| H1 | snapshot + 增量 → 状态 | 与服务端 `GET /tasks/:id` 一致 | 部分（无快照路径） |
| H2 | 重复 id | 幂等，结果不变 | 缺 |
| H3 | 乱序 id | 缓冲后一致 | 部分（有排序，无去重） |
| H4 | 未知事件 | 出现在"原始事件"列表，不消失 | 缺 |
| H5 | `blocked` → confirm | 只发一次请求，按钮在收到 `task.state` 前禁用 | 缺 |
| H6 | 构建期断言 | 依赖图不含 `@assistant-ui/react-pi`，源码不含 `child_process`/`spawn` | 缺 |

### 4.3 不安装 `pi` 的验证方式

1. **`MTA_RUNTIME=mock`**：`server/src/runtime.ts:14-46` 已有确定性 mock，
   发 `agent_start → message_end(结构化 JSON) → agent_settled`，无模型、无文件写入。
   API/Worker 全链路 E2E 用它。
2. **假 `pi` 可执行文件**：在 PATH 前置一个 shell/node 脚本，读 stdin 的 JSONL，
   按脚本回放事件（含 `tool_execution_start/end`、`agent_settled`、`usage`、
   以及一个**故意未知**的 `some_new_event`）。用于：
   - 验证 JSONL 半行缓冲（`adapter.ts:191-226` 的 `buffer` 逻辑）；
   - 验证 `--session-id` 透传与 resume 分支；
   - 验证未知事件 `type:"unknown"` + `rawType`；
   - 验证 `agent_settled` 前退出 → `failed`。
   现在 `settle.test.ts` 用 `EventEmitter` 假 child 做同一件事，假二进制是它的进程级补充。
3. **崩溃注入**：`node dist/worker.js` 作为子进程启动，`SIGKILL`，再用同一
   `MTA_DB_PATH` 重启。断言放 DB，不放日志。
4. **并发**：两个 `ExecutionStore` 实例指向同一临时文件（同进程），
   再加两个子进程（跨进程）。
5. **UI**：投影 reducer 纯函数测试 + `jsdom` 组件测试；**不**启动真实 SSE 服务器，
   用事件数组喂 reducer。
6. **明确不覆盖**：Pi 真实行为（信任提示、extension 加载、`get_session_stats` 语义）
   只能装 `pi` 后验证，继续留在"已知缺口"，不得用 mock 结果冒充。

---

## 5. 落地顺序建议

原则：**先契约与数据模型，再 Worker，最后 UI**。每阶段独立可验收，
且每阶段结束时 `just check` 必须为绿。

### 阶段 0 —— 修复红色基线（阻塞，0.5 天）

- 修 `runtime-pi/src/adapter.ts` 的半成品重构（`holder` 未定义、`settle` 参数不匹配），
  使 `agent_end` 不结束长驻 run、`agent_settled` 才结束、提前退出判 `failed`。
- 修 `retryTask` / `recoverAttempt` / `completeSuccess` 的取消语义（缺陷 D2/D3，对应红测 C5、新增 C4/C6）。
- 修 D11：`streamEvents` 的 `done` 必须被消费（并入 `settled` 或显式 `catch`），
  保证缺 `pi` 时 `runOnce()` 不产生未处理 rejection。
- 把 untracked 的 P6 文件提交，形成可回滚基线。

**完成判据**：`pnpm -r build && pnpm -r typecheck && pnpm test` 全绿（≥ 94 例），
`just verify-docs` 绿；新增 F10 回归测试通过（缺 `pi` 时不崩进程）。

### 阶段 1 —— 契约与数据模型（1.5 天）

- `domain` 与 `orchestrator` 统一 `TaskStatus`；新增 `AttemptExitReason`。
- `migrations` + `user_version`；扩列（§2.2）；`outbox_v2`；`workers` 表。
- `PRAGMA busy_timeout`、`changes===1` 断言、`upstreamEventId` 与唯一索引。
- 修 D1（fanout 整组判定）、D4（三条路径统一 unknown 判定）、D5（幂等域带链）。

**完成判据**：空库建库与"v1 库 → v2 库"两条迁移路径都有测试；
A6/B5/C4/C6/X1/X2/X3/X4/X5 全绿；`events` 重投不产生重复行。

### 阶段 2 —— Worker 语义闭环（2 天）

- `workers` 表租约：同 workspace 第二个进程退出。
- `spec.session` 接线 + capability `sessionResume` + 文件探测 + 快照回退（A7/A8）。
- 取消宽限期（30s）+ `cancel_requested_at` + 强制 orphan（C7）。
- 退避带 jitter（C2）；Dead Letter 标记与查询（A4）。
- 错误分类：`runtime_missing` / `idle_timeout` / `lease_lost` / `unknown_tool_outcome`。

**完成判据**：A1–A8、B1–B4、C1–C7 全绿；Worker 子进程 SIGKILL 重启测试稳定
（连续跑 20 次不 flake）。

### 阶段 3 —— API v1 与 SSE（2 天）

- `/api/v1` 路由表、错误码、JSON Schema 校验、`Idempotency-Key`、`If-Match`。
- `workspacePath` 服务端解析（F3/F4）。
- 事件分页 `hasMore`（F5）；SSE `Last-Event-ID`、snapshot 首帧、慢消费者、`task.state`。
- 全局流改为"按 `updated_at` 游标"，或直接由 store 变更回调驱动（D10）。
- `/dead-letter`、`/capabilities`。

**完成判据**：F1–F9、G1–G7 全绿（F10 在阶段 0 已建立，须保持绿）；用 `MTA_RUNTIME=mock`
跑通"创建 → 流式观察 → 取消 → 重试 → 完成"脚本化 E2E；loopback 下 UI 尚缺但 API 可用。

### 阶段 4 —— assistant-ui 只读投影（2 天）

- `packages/web` 已有 `api/`、`chat/`（含 `mapping.ts` + 14 例测试）、`hooks/`、`components/`、`lib/`；
  缺入口 `src/main.tsx`（`index.html` 已引用），缺依赖安装与锁文件条目。
- **构建/门禁接线**：`pnpm-lock.yaml` 无 `packages/web` importer，`just build`/`just typecheck`
  因此不会构建它；需 `pnpm install` 生成 importer，并把 web 纳入根 `build`/`typecheck`，
  否则 UI 的编译错误在 CI 中不可见。
- 只装 `@assistant-ui/react` 与其 peer；**显式不装** `@assistant-ui/react-pi`。
- 补 H1–H6：快照路径、id 去重、乱序缓冲、未知事件折叠、confirm 幂等、构建期断言。
- 开发模式横幅；blocked 三选一；`FALLBACK_CATALOG` 不得让用户手填 `workspacePath`
  （改为禁止创建并提示"目录接口不可用"）。

**完成判据**：H1–H6 全绿；`packages/web` 依赖图无 `react-pi`/`child_process`；
`just build && just typecheck` 覆盖 web 且为绿；手工验收：断网 30s 后恢复，
UI 状态与服务端 `GET /tasks/:id` 一致。

### 阶段 5 —— P7b 发布门禁（2 天，可独立排期）

- 会话 cookie 鉴权 + SSE cookie 鉴权 + CSRF。
- 租户/项目授权逐路由校验；`/catalog` 按身份过滤。
- `audit_log` 全量操作；限流。
- 关闭 `auth: "loopback-only"` 文案，`/capabilities` 如实上报。

**完成判据**：跨租户访问全部 403；审计可查询；`/health` 不再声称 development；
发布检查单签署"沈 P7a 结论不得用于 P7b"。

### 依赖与并行

```text
阶段0 ──▶ 阶段1 ──▶ 阶段2 ──┬──▶ 阶段3 ──▶ 阶段4
                              └──▶ 阶段5（可与 3/4 并行，但必须在对外前完成）
```

阶段 3 的路由与阶段 4 的 UI 可两人并行，前提是阶段 3 先冻结 SSE 帧格式
（§3.2）并写进 `packages/server/src/contract.ts` 作为唯一来源。

---

## 附录 A 不变式 → 检查点

| 不变式 | 代码检查点 | 测试 |
|---|---|---|
| 未知事件不可静默丢弃 | `adapter.ts:42-43` 落 `unknown`+`rawType`；`events` 全量追加；API 分页 `hasMore`；SSE 原样转发；UI 折叠展示 | A6/G4/H4 |
| 交接须声明 | `handoff-intent.ts:80-93` 只认 `handoff_to`；`durable-worker.ts:169-171` | X3/X4 |
| 单活跃 Worker | `workers` 表 workspace 唯一 + 租约 | B3 |
| 每 Task ≤3 Attempt、重启不清零 | `tasks.batch_attempts` 持久判定 | A4 |
| 运行时缺失降级 failed 不崩调用方 | `durable-worker.ts:206-210` 捕获后 `finishFailure`；**现状另有 D11 未处理 rejection 必须修**；新增 `runtime_missing` 分类与创建预检 | F9/F10 |
| 未知工具结局需人工确认 | 三条路径统一 `unknownHighRiskTools`；`blocked` + confirm | A3/C8 |
| 交接/子进程事务化不重复 | `completeSuccess` 单事务 + outbox 链内唯一 | X1/X2/X5 |
| 服务端权威 | `workspacePath` 服务端解析；UI 禁止 `react-pi` 与进程调用 | F3/H6 |
| 分阶段发布 | P7a loopback + 开发横幅；P7b 鉴权门禁 | 阶段 5 判据 |

## 附录 B 待决问题（不在本文单方面决定）

1. **usage 语义**：Pi 的 `message.usage` 是"该消息"还是"会话累计"？`CanonicalEvent`
   注释写"累计"，`cost-report` 按"单条"聚合。两者只能有一个对，必须以
   `pi` 安装后的真实会话文件钉死（影响 §4.1 R4 与 E1/E2）。
2. **会话续跑的真实约束**：`--session-id` 在会话文件不存在时是"新建"还是"报错"？
   决定 A8 的回退触发条件。需实测 `pi --help` 与一次真实 resume。
3. **`@assistant-ui/react` 具体导出**：external store 接法的 hook 名与消息形状以
   安装后类型为准；本文只锁形态，不锁 API。
4. **Dead Letter 的运营动作**：是否允许"重置 Attempt 计数"？若允许，需要审计与上限，
   否则 3 次上限可被无限绕过。
5. **多 API 副本**：P7 明确不承诺；若团队部署需要多副本，SSE 与 SQLite 写竞争必须先解决
   （Postgres + LISTEN/NOTIFY），这是一次独立决策，不应夹带在 P7b 里。
6. **`node:sqlite` 退出实验状态的时点**：影响 P7b 的运行时基线。
