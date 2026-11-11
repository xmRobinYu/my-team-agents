# my-team-agents 架构设计

> 本文档与仓库同步；仓库为唯一事实来源。
> 源文件：`docs/architecture.md`。描述的是**当前已实现**的结构与**刻意保留但尚未生效**
> 的扩展接口，两者明确分开标注。

## 1. 总体形态

pnpm workspaces 单仓多包，TypeScript strict（含 `noUncheckedIndexedAccess`），
Node ≥ 22，ESM。

```text
                    ┌─────────────────────────────┐
                    │  packages/cost-report       │  每日自评估 / 成本归因 CLI
                    └─────────────────────────────┘
                                 ▲ 读取 Pi 会话日志
┌────────────────────────────────┴───────────────────────────────┐
│                     packages/orchestrator                       │
│  dispatcher（执行→收集→settle→派发）                             │
│  handoff-intent（解析声明式交接）                                │
│  stall-watchdog（无事件超时取消）                                │
└───────┬───────────────────────────────────────┬─────────────────┘
        │ 使用 RuntimeAdapter 契约               │ 使用 Handoff 护栏
        ▼                                       ▼
┌───────────────────┐                  ┌──────────────────┐
│ runtime-pi        │                  │ domain           │
│ runtime-cli       │──实现──────────▶│ entities +       │
│ (claude/codex/dsh)│   runtime-core   │ handoff 护栏     │
└───────────────────┘                  └──────────────────┘
        │ 实现契约
        ▼
┌───────────────────┐
│ runtime-core      │  RuntimeAdapter / RunSpec / RunHandle / CanonicalEvent
└───────────────────┘
```

## 2. 包职责

| 包 | 职责 | 关键文件 |
|---|---|---|
| `runtime-core` | 运行时抽象与规范事件契约，不含任何具体进程管理 | `src/adapter.ts`, `src/events.ts` |
| `runtime-pi` | Pi 的 RPC 适配器（唯一完整 loop） | `src/adapter.ts` |
| `runtime-cli` | claude / codex / dsh 的 CLI 适配器（v1 最小实现） | `src/adapter.ts` |
| `domain` | 实体与交接护栏（纯函数，确定性判定） | `src/entities.ts`, `src/handoff.ts` |
| `orchestrator` | 调度闭环：执行、事件收集、交接派发、停滞看门狗 | `src/dispatcher.ts`, `src/handoff-intent.ts`, `src/stall-watchdog.ts` |
| `cost-report` | 会话日志解析 + 每日成本/用量报告 | `src/parse.ts`, `src/aggregate.ts`, `src/cli.ts` |

## 3. 运行时抽象

`RuntimeAdapter.start(spec)` 返回 `RunHandle`：事件流 `events` 与终止信号 `settled`。
`RuntimeCapabilities` 显式声明每个运行时的能力（streaming / steer / cancel / approval /
sandbox / workspacePerRun / agentDirPerRun / usageAttribution / costCap），使服务端不会
提供该运行时实际不支持的操作。

设计约束：

- **未知事件不丢弃**：上游事件名无法映射时落为 `type:"unknown"`，并保留 `rawType`。
- **`args` 进入规范事件**：`CanonicalEvent.args` 承载工具调用参数。交接意图必须能从
  事件流还原，否则就只能回头解析散文。Pi 与 CLI 适配器都填充该字段。
- **CLI 适配器是 v1 最小实现**：不承诺事件流保真，不支持 mid-run steer。

### 已核实的运行时事实

- **Pi**：`pi --mode rpc --no-session` 为长驻子进程，严格 JSONL 分帧；`get_session_stats`
  返回 tokens/cost/contextUsage；消息级 `usage{...cost}` 支持逐条归因；
  `agentDir`（默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖）承载
  settings/models/auth/AGENTS.md/SYSTEM.md。RPC/JSON/print 模式**无法展示交互式信任
  提示**，因此适配器必须显式传 `--approve`/`--no-approve`。
- **Pi 的内建工具里没有 `handoff_to`**：1.4.0 的内建只有 `read`/`bash`/`edit`/`write`（加
  `grep`/`find`/`ls`）。声明式交接因此依赖本仓库自带的 Pi 扩展
  （`packages/runtime-pi/pi-extensions/handoff-to.js`），经**显式** `--extension <path>` 加载 ——
  只有显式路径不受 `--no-extensions` 与项目 trust 门控（Q44/D1）。`--extension` 可重复叠加，
  不是 last-wins。
- **`<agentDir>/skills/` 不是 Pi 的发现路径**：项目级技能根是 `.pi/skills/`（受 trust 门控）与
  `.agents/skills/`，`<agent-dir>/skills/` 只属于 `PI_CODING_AGENT_DIR`。
  人格技能只能通过可重复的 `--skill <dir>` 注入（Q43）。
  同理 `--session-dir` 决定会话存储位置（Q44/D3）。
- **dsh**：实测是 cordis 插件/profile 启动器（`~/.dsh/profiles/<name>/cordis.patch.yml`），
  不是编码 Agent 运行时；仅作为 CLI 适配器接入。
- **claude**：`--output-format stream-json`、`--input-format stream-json`、
  `--max-budget-usd`、`--permission-mode`。
- **codex**：`--sandbox`、`-a/--ask-for-approval`、`--full-auto`、`-C/--cd`；其稳定的
  结构化 JSON 事件输出**尚未确认**，因此当前按纯文本降级归一化（已知缺口，见 §9 第 1 条）。

## 4. 协作域模型

```ts
Tenant                      // 租户
Project  { workspacePath, agentDir? }   // 拥有工作区；agentDir 为扩展接口
Group    { projectId }                  // 群聊只是项目上的视图
Member   { kind, projectId | null, runtime, grade? }
Task     { tenantId, projectId, memberId, prompt, status }
Handoff  { fromTaskId, toMemberIds, reason, depth }
```

已确立语义（`CONTEXT.md` 决策记录 Q2/Q14/Q15/Q34/Q35）：

- 执行型 Agent 绑定**恰好一个**项目（其技能与记忆位于该项目工作区）。
- 汇报类角色（PMO / 群管理员 / HR）可跨项目 → `projectId: null`。
- 交接是**声明式**的（`handoff_to` 工具调用）；agent 消息中的 `@name` 是次路径触发。
  Q34 修订 Q14：`handoff_to` 优先，两条路径按目标去重（Q35）。平台代码不抓任意散文。
- 交接只在 run **settle 之后**派发，不在流式中扇出。

## 5. 调度闭环

`dispatch(request, deps)` 的一次执行：

1. 解析成员对应的适配器；
2. `adapter.start(spec)` —— **置于 try 内**：缺失运行时二进制会同步抛出
   （`spawn ENOENT`），必须降级为 `status:"failed"`，不能穿透调用方；
3. 顺序消费事件，回调 `onEvent`（供 UI / 看门狗 ping）；
4. 等待 `settled`；
5. 从已收集事件中提取 `handoff_to` 意图；
6. 逐条交 `evaluateHandoff()` 判定（确定性护栏）；
7. 通过则递归派发（depth+1），拒绝则记入 `rejected`。

返回 `DispatchOutcome { runId, status, dispatched, rejected, issues, events }`；
运行时抛错时错误文本同时进入 `issues`。

护栏默认值（与 teamagentx 实测配置对齐）：fanout ≤ 20、depth ≤ 100、chain budget ≤ 20、
revisit ≤ 5。护栏判定本身是确定性纯函数（`packages/domain/src/handoff.ts`）；
审计留存尚未实现，属 P7b（见 §9 已知缺口第 5 条与 `CONTEXT.md` Q23）。

`StallWatchdog` 用注入式时钟与 `unref()` 定时器实现，`ping()` 由事件流驱动，超时触发
`onStall` → 取消该 run，避免卡死的 run 长期占用队列槽位。

## 6. 成本与自评估

`cost-report` 从 Pi 会话 JSONL 解析消息级 usage，按
`tenant / project / member / model` 聚合并输出表格或 JSON。`--since-file` 写回
entry-id 游标，使**每日重复运行幂等**（已实测：第二次运行新增 0 token）。

## 6.5 持久化执行内核（P6）

`ExecutionStore`（`orchestrator/execution-store.ts`）用 SQLite 持久化
Task / Attempt / Event / Usage / 交接 outbox。

- **崩溃不丢**：任务与事件落库，进程重启后可继续领取；`busy_timeout` 支持
  API 与 Worker 分离的两个进程并发访问。
- **租约**：心跳续租，过期由 `recoverExpired` 接管；fencing token 拒绝旧
  Attempt 的迟到写入。
- **重试**：每批次最多 3 次自动尝试 + 退避；人工重试开新批次并保留历史；
  确定性恢复快照携带原始任务与上次错误；runtime 支持时恢复原 Pi 会话（Q18）。
- **安全**：未知非只读工具结果转 `blocked`，需人工确认；取消链不可被重试复活。

## 6.6 服务端与 UI 投影（P7a）

`packages/server` 提供 Fastify API 与 SSE，API 与 Worker 为独立进程，共享 SQLite。

UI 用 `@assistant-ui/react-pi` 的 `usePiRuntime`。`PiClient` 是传输无关接口，
因此浏览器经 `createPiHttpClient({ baseUrl: "/api/pi" })` 连**我们自己的服务端**，
**不直连 Pi 进程**。`pi-thread.ts` / `pi-routes.ts` 把 Task 投影为 Thread、把
持久化事件翻译为 PiClient 事件，服务端保持唯一权威；刻意不使用会绕过持久化
内核的 `createPiNodeClient`。详情面板仍读 `/api/tasks/:id`，因为 attempts、usage、
handoffs、chain 是 PiClient 契约不建模的 P6 证据。

**群聊投影（P8/I7+I8，Q42）**：`ChatRoom` 与 Task 共用同一套 `/api/pi` 路由，命名空间落在
thread id 上 —— 群是 `room:<roomId>`，单 agent 是裸 task id（P7a 格式不变）。这不是"碰巧不撞"：
`ExecutionStore` 只产 `task-<uuid>`、`RoomStore` 只产 `room-<uuid>`，`:` 不属于任一字母表，
`pi-thread-id.ts:threadKind()` 是由字符串本身判定的全函数，不查库。作者身份不能靠
`PiAgentMessage.role` 表达（契约里 `PiThreadMetadata` 也没有 `kind` 字段），于是 agent/system
消息走 `role:"custom"` + `customType: room-agent|room-system` + `details{...}` + `display: true`，
而 `role:"user"` 保持原生（react-pi 靠同文本的 user 条目对账乐观消息）。群 thread 的
`status` 只看"有没有 Task 在飞"，**不看** `roundCount`/`chain`/`terminated`：流状态约束未来触发，
不代表当下有无工作。取消只作用于当前在飞的那**一条 chain**：
`requestCancelChain` 会把该链上所有未进入终态的 Task 判成 `cancelled`，
所以取消全部 chain 是摧毁尚未发生的工作。删除 thread 是 **tombstone + 取消在飞**，
不删 P6 行、不删群消息。三栏 UI（`packages/web/src/rooms`）渲染时只信 `details`/`customType`，
不信 `role`。单 agent thread 只接受第一条消息，
追问返回 409 `FOLLOW_UP_NOT_SUPPORTED`（多轮由群 thread 承担）。

**按群配置轮次上限（AC5.4）**：`PATCH /api/rooms/:id {maxRounds}`（1–100 整数；越界 400
`INVALID_MAX_ROUNDS`，不存在的群 404 `ROOM_NOT_FOUND`）。刻意**拒绝而非截断**：截断会让响应
报告一个调度器实际并不持有的预算。端点只暴露 `maxRounds` —— 协调者身份与群规则在导入时定型，
改它们会移动守卫判定所依赖的身份，是另一件事。

## 6.7 事件入口与触发路由（P9a）

**一句话**：让任务的起点从人身上拿走 —— 外部信号（告警 / 意见 / 定时 / Webhook）经统一事件契约进入系统，
由**声明式规则（数据）**决定叫醒谁、在哪个工作区、用什么指令，执行仍复用 P6 耐久内核。

```
POST /api/ingest/events
   │
   ├─ 归一化 normalizeEvent（纯）  type/summary 必填；未知字段原样进 payload（G5）
   │
   ├─ 1. delivered   同 dedup_key=sha256(source\x1fid) 已存在 → 返回原事件与原 taskIds
   ├─ 2. unmatched   无规则命中 → 仍落库、记 outcome，绝不静默丢
   └─ 3. 逐条命中规则（priority 降序，同名按 name 定序 —— 全序，可复现）
          ├─ coalesced  同 (rule,lane,subject) 已有未终态 Task → 并入，推 available_at
          ├─ deferred   超规则速率窗口 → 不丢，记 retry_at，由 worker tick 重投
          └─ dispatched 建 Task（lane 串行键 / tools 只读清单 / event_id 溯源）
```

**三种结局互斥，判定顺序是契约**（与 `room-guards.ts` 的固定顺序同源）：`dispatched` > `coalesced` > `deferred`，
一个事件只记一个 outcome，即便多条规则命中。

**新增表**（同一个 `DatabaseSync` 句柄，与 tasks/rooms 同库同事务）：

| 表 | 用途 |
|---|---|
| `inbound_events` | 入站事件。**不叫 `events`** —— `ExecutionStore` 已占用该名（持久化 per-attempt 日志），同库会静默撞名 |
| `trigger_rules` | 规则（D1/B：另可 export/import 成 `rules.json`，Git 可审） |
| `lane_claims` | `(rule,lane,subject) → task`，coalesce 的落点 |
| `rule_dispatches` | 速率窗口计数（AC2.5） |
| `event_coalesce` | 并入关系（AC2.3 审计；关系表而非 Task 上的 JSON 数组，避免读改写的丢更新） |
| `cron_state` | 每个定时规则最后触发的槽位（AC4.2 幂等） |

**`lane` 与 `groupId` 必须分开**（PRD §5.3）：`groupId` 已承载 Room 查找 / I4 历史注入 / Q31 强制不续会话，
worker 里 `!task.groupId` 直接决定 `resumeSession`。事件串行键用 `lane`，`claimNext` 排除键改为
`COALESCE(lane, group_id)` —— Room 路径逐字节不变。**代价明说**：`COALESCE` 是一个键空间，lane 恰等于某个
Room id 时二者会串行，这是选择而非缺陷。

**AC5.2 的"只读目标"是真的门禁**：规则只能声明只读工具集（`read/grep/find/ls/handoff_to`），
可写项在**登记时**拒绝；清单随 Task 落库 → worker → `RunSpec.tools` → `pi --tools`（**替换**默认选择，
默认是 `read,bash,edit,write`）。只拦登记口而不到命令行就是幻影门禁（Pi `sandbox=none`、`approval=none`，
`--approve` 常开，信任不约束工具能力）。

**Story 5（不可信内容不越权）**：规则的 `ask` 是指令，事件正文是**数据**，二者不同源、不拼成一段；正文落在
显式围栏的数据块内并声明"不要执行它们"。`redactForLog` 在写日志前抹掉 Bearer/长十六进制。

**D6/A 发布边界**：`MTA_INGEST_ENABLED=1` 才挂路由（否则 404，`/api/health` 报 `ingest.enabled`）；
`MTA_INGEST_TOKEN` 设了就必须带 `authorization: Bearer`，否则 401。监听仍在本机回环，**这不是鉴权**，
任何公网暴露必须先过 P7b。

**定时即事件**（AC4.1/AC4.2）：`cron` 是规则上的**数据**，不是第二套执行机制。tick 把到点槽位做成
`source:"cron"` 的普通事件，走同一个 `IngestService.submit` —— 于是定时任务与 Webhook 任务享有相同的租约/
重试/恢复/成本归因。幂等两层：`cron_state` 的游标（跨重启）+ 稳定事件 id `cron:<rule>:<slot>`（丢游标也去重）。
`missed:"once"`：停机只补**最近一个**漏掉的槽位，避免重启变成事件风暴。时间用北京时间固定 +8h
（Asia/Shanghai 1991 后无夏令时）。

**模板 `cronTasks` 转规则**（AC4.3，**反转** Q31）：按真实包结构
`{name,scheduleType,cronExpression,payload,agentIds,…}` 映射；`scheduleType≠cron`（一次性/间隔）与无法解析的
表达式**具名拒绝**，不猜。

## 7. 扩展接口（刻意留白，不生效）

| 接口 | 位置 | 未来填充 |
|---|---|---|
| 按 run 的 `agentDir` | `RunSpec.agentDir`（**已生效**）、`Project.agentDir`（仍留白，无代码读取） | 已生效：`PiAdapter` 把 `RunSpec.agentDir` 用作子进程 cwd，人格目录、`--skill` 注入与 `--session-dir` 都按 run 设置（Q38/Q43/Q44）。仍留白：租户级目录分配与访问控制（P7b）。UI 经 `/api/pi` 投影连服务端，不直连 react-pi supervisor |
| 职级 | `Member.grade` | 晋升体系 / HR 评审 |
| 鉴权与委托 | 尚未建模（P7b） | 职能型 / 分身型的前置条件；当前仅本机回环模式 |
| 技能/工具市场 | 尚未建模 | 单 agent 的清单/安装/卸载已完成（I9/Q43）；市场、版本化与跨 agent 复用仍未建模 |

## 8. 治理机制

- `just check` = build → typecheck → test → verify-cli → test-guardrails → verify-docs →
  verify-bitable → test-scripts → verify-packages。**顺序有语义**：
  包之间通过 `dist/*.d.ts` 互相消费，未 build 的干净检出会 `TS2307`。
  测试另经 `vitest.config.ts` 别名解析到 `src/`，因此 `pnpm test` 单独可跑（已实测）。
- 命名与规则守卫：`.git-hooks/check-naming.sh` 拒绝 `.bak`/`_v2`/`tmp/` 等产物名，并要求
  规则文件（`AGENTS.md`、`CONTEXT.md`、`constraints.yaml`、`justfile`、`vitest.config.ts`、
  `tsconfig.base.json`、`.git-hooks/*`）变更必须携带 `RULE_CHANGE_REASON`。
- 文档同步：`just sync-docs` 把 `docs/`、`AGENTS.md`、`CONTEXT.md` 覆盖同步到飞书
  `my-team-agents` 知识库（空间 ID `7701231058624187646`）。

## 9. 已知缺口（不掩盖）

1. codex 稳定结构化事件输出未确认 → 归一化按纯文本降级。
2. 无 eslint → 刻意不提供 `just lint`，避免幻影门禁。
3. AC5.2 的"超限后不再处理新触发"**已在真实模型下直接观察到**（`scripts/prd-acceptance.mjs`
   第 5 项的独立探针）：`【流程守卫·轮次上限】齐活林：本轮已达轮次上限（1/1），不再处理新的
   agent 触发`，目标 Task 数为 0。这条探针必须同时满足两个条件才能看到 `ROUND_CAP`，
   否则会先撞上别的分支 —— 判定顺序是 `terminated → LOOP → ROUND_CAP`（`room-guards.ts:39`）：
   - **群必须未被终止**：`maxRounds=1` 时收尾不占轮次、协调者随即输出 `[讨论结束]`，`terminated`
     优先于轮次上限，所以默认构造看到的永远是 `【流程守卫·已终止】`。探针把群的
     `coordinator_agent_id` 置空（同时验证 Q40 的无协调者回退），`terminated` 因此不会变真。
   - **目标必须在链外**：目标若已在链内，先命中 `LOOP`，`ROUND_CAP` 轮不到。
   域外事实：这不是"多写一条断言"，而是原先那条限制的成因本身被证伪了。
4. I8 三栏 UI 的浏览器验证**做过**（真实 Chromium + CDP，断言的是渲染后的 DOM），
   但脚本**未保留在仓库里**，因此 UI 渲染**没有**可重复的检查；
   `packages/web` 也没有自动化测试（vitest 只收 `packages/**/*.test.ts`）。
   群 thread 的服务端契约由 `pi-room-client.test.ts`（真实 client + 真实 reducer）证明，
   UI 渲染本身靠人工核对。
5. P7b 未做：鉴权、租户隔离、审计；当前仅本机回环，不可暴露到共享环境。
   persona 会话写入已收窄到 `<agentDir>/.pi/sessions`（Q44/D3），
   但这只是把文件放近，**不是沙箱**：同机文件系统仍可达，完整隔离属 P7b。
6. `node:sqlite` 为实验性 API，测试会打印 `ExperimentalWarning`。
7. 技能：加载机制（`--skill` 注入）与 `/api/rooms/:id/agents/:agentId/skills` 服务面已完成，
   但 `packages/web` 里**独立的技能管理页面未做**；技能/工具市场仍未建模（§7）。
8. 单 agent thread 不支持追问：`POST /api/pi/threads/<task>/messages` 只接受第一条消息，
   之后返回 409 `FOLLOW_UP_NOT_SUPPORTED`；多轮由群 thread 承担（Q42）。
   这是记录的限制，不是遗漏。
9. **更正一条我自己写错的归因**。第 5 项曾记录为"强制收尾依赖模型输出
   `[讨论结束]`，实测不稳定（r7 三次 Attempt 全失败）"。`scripts/prd-acceptance.mjs`
   后来直接复现出该形状并给出真因：`Attempt#1 status=failed error=no events for 120000ms`
   —— 那是 P6 stall watchdog 的**无事件超时**（`durable-worker.ts` 的 120s，provider 挂起），
   三次 Attempt 各撞一次。协调者不是"不肯收尾"，是**根本没拿到模型响应**。把它写成
   模型不稳定，是把基础设施故障记成了被测行为。
   验收脚本的判定因此分层：**只有守卫真的漏放（上限已满仍建出目标 Task）才算 FAIL**；
   provider 挂起、预算耗尽、模型不肯按指令 @ 人都报 **BLOCKED 并给出具名原因**，
   且判定前先给平台自动重试留出窗口（`retry_wait` 不是终态）。断言条款一个没减。
   另注：worker 队列**串行**（`runOnce` 一次只领一个），于是一次挂住的运行会饿死后续
   所有群的任务 —— 它们全部停在 `queued`，在消息流里看起来与"守卫没生效"一模一样。
   这是记录的限制，不是遗漏（`CONTEXT.md` Q44）。刻意**不改并发**：并发要同时处理租约
   续期与 provider 限流，是独立决定；改判定分层已经足够把故障与被测行为分开。
   现在验收脚本进场先跑 **provider 预检**（一次极小的真实调用），provider 不应答就以
   退出码 2 结束，而不是让六项各烧满预算换一墙 BLOCKED（`CONTEXT.md` Q45）。
10. **全局 CLI 靠绝对路径解析，不靠 PATH**。`lark-cli` 与 `pi` 装在装它们时那个 node
    版本的全局 bin 下，shell 换版本后 PATH 就不含它；原先两处都因此误判 —— 同步脚本报
    "not found, install it"（其实是 PATH 错配），`pi-smoke.sh` 更直接
    `SKIP ... exit 0`（门禁没跑却算通过，违背本文件对它的说明）。现在统一走
    `scripts/resolve-bin.mjs`，缺失一律非零退出。`CONTEXT.md` Q45。

11. **Bitable 的写后读不是立即一致的**。`+record-batch-create` 返回 ok 之后，紧接着的
    `+record-list` 仍可能读到写前的快照。第一次真实同步就撞上了：10 条 `项目阶段` 记录
    全部写入成功（手工 `+record-list` 能查到），但同步脚本的校验读看到 0 条，于是报
    `MISMATCH` 并 `exit 1` —— **一次正确的同步被报成失败**。现在只对"本次确实写过"的
    校验读做有界重试（4 次，1.5s/3s/4.5s 退避）；无写入的运行不重试，真失败仍失败。

12. **`+table-create` 不返回 `table_id`**。实测响应是
    `{"ok":true,"identity":"user","data":{"fields":[...]}}` —— 只回显建表时给的字段
    schema，没有任何 id。原先的实现拿不到 id 就抛错，后果比不报错更糟：表**已经建出来了**，
    每次重试都会再留一张同名表。现在改为建完重读 `+table-list` 按名认领，且只认领
    "建表前不存在"的那个 id（`adoptCreatedTable`），重名多于一概拒绝而不是猜。

    这两条都不是上游缺陷，是**我们没有先测量就假设了响应形状**。同类的还有一条已在
    `scripts/feishu-docs.test.mjs` 里钉死：docx wiki 节点的 `obj_token` 是否就是
    `docs +update --doc` 要的 `document_id` —— 实测相等，但那之前只是从 bitable 脚本
    的形状推断的。

13. **两份验收文档曾给出相反结论**。`docs/prd/multi-agent-group-chat.md` §5 的 35 条 AC
    全部已勾，而同目录 `-issues.md` 的任务级清单里还有 37 条未勾 —— 描述的是同一批工作。
    核实后：**功能全部存在**（`ChatRoom` 定义与导出、四张表、状态落库、模板导入、
    mention 派发、群注入、双路径去重、`/api/pi` 投影、三栏 UI、技能安装/卸载都有实现与
    测试），未勾只是清单没随实现更新。已逐条勾选并附上具体测试用例作为证据，
    而不是只翻复选框。
    唯一真正"只到一半"的是 **导入没有 UI 入口**（仅 `POST /api/rooms/import`）：PRD §5
    未要求 UI，故不计未完成，但它是 `packages/web` 缺口的同类，一并记在这里。
    教训：**复选框不是证据**。回答"是否全部完成"必须以实现 + 测试 + 真实运行为准，
    两处如果冲突，先查代码再回答。

14. **默认验收模型会因外部配额而不可用，验收因此必须在预检处停下**。本轮实测：直接调用
    `pi --model airouter/deepseek-v4.1-flash` 返回
    `402 {"type":"free_request_quota_exhausted","message":"DeepSeek v4 flash 福利版当前使用人数
    较多，请稍后再试；或切换模型代号为 deepseek-v4-flash 立即使用"}`。这是配额，不是缺陷。
    预检在 64s 内把它变成 `ABORT ... 退出码 2`，而不是六项各烧满 300s 换一墙 BLOCKED ——
    这正是 Q45 想要的区分。provider 建议的 `airouter/deepseek-v4-flash` 6.7s 就绪，可用
    `PI_SMOKE_MODEL` 覆盖后重跑。
    另记一条实测缺陷（已修）：外部 `timeout`/Ctrl-C 只杀本进程，detached worker 会活下来并
    继续持有临时 SQLite（实测留下 18 分钟的野进程 + 整个临时目录）。现在
    `SIGINT/SIGTERM/SIGHUP` 都走 `teardown(130)`。

15. **第 4 项（A→B→A 真实模型回边）仍未在真实模型下观察到，两次实测给出了具名原因**。
    2026-11-10 两次跑第 4 项，两种不同形状，都不是"守卫漏放"：
    - 第一次：A 的 Task `status=failed attempts=3`，`error=missing valid structured result
      (outcome, summary, artifacts, remainingRisks)`，模型的原始输出是它自己的
      `AGENTS.md` 正文。A 一个字都没进群，回边无从谈起。
    - 第二次：A 成功发言，但**一句话里同时 @ 了 B 和 @ 自己**，于是被 `LOOP` 拦成
      A→A 一跳（群里落下 2 条 `【流程守卫·循环】`）；B 的 Task 也 `failed attempts=3`，
      同一个 `missing valid structured result`。链是 `A → B`，B 从未发言。
    探针现在把这两种形状分开报（`absent` / `failed` / `A→A 假 LOOP`），并明说
    "落了一条 LOOP 不等于回边成立"。**A→B→A 的确定性证明仍只有 mock**：
    `packages/orchestrator/src/room-guards.test.ts:347`（真实 `applyRoomGuards` +
    真实 store，断言第二跳不建 Task、留系统消息）。
    实测附带的两个坑，写在这里免得下一个人重踩：
    - `MTA_I10_ITEM_MS` 的单位是**毫秒**（默认 `300_000`）。按"秒"传 `600` 会让单项
      预算只剩 0.6s，`settleRoom` 一进场就因超时返回，任务状态还是 `running`，
      看起来像"守卫没生效"。我本人踩过一次，该次结果作废。
    - `settleRoom` 的安静判据是"本群所有 Task 终态 **且** 任务集合连续 3s 不变"；
      `running` 不是终态，所以它不会提前返回。第一次那个"1.2s 就返回"纯粹是预算没了。
    - **`missing valid structured result` 的真因是限流，不是模型不肯按格式作答**。
      同一提示直接调 `pi -p --model airouter/deepseek-v4.1-flash --thinking high`
      时，provider 回的是
      `429 {"message":"inference exceeds tpm/rpm limit","code":"RateLimitExceeded.EndpointTPMExceeded"}`。
      平台把一次被限流的运行记成 `failed attempts=3`，看起来像模型行为问题
      （我先前就照这个思路误判过一次）。**分辨方法**：日志里若只有
      `missing valid structured result` 而无 provider 报错，应先用同一模型直接跑一次
      最小调用取证，再决定这是产品缺陷还是配额。`pi` 的错误不会自动落进
      `tasks.error`，所以 `tasks.error` 单独不足以归因。

16. **一个坏 `agentDir` 曾打死整个 Worker 进程**（已修，2026-11-11）。
    `PiAdapter.streamEvents` 把 spawn 失败交给 `fail(err)`，而 `fail` 只 reject
    `streamEvents` 返回的 `done` —— 那个 Promise **返回后无人观察**（`start()` 只
    交出 `events.iterable` 与 `settle()`）。未处理拒绝在 Node ≥15 是致命的，于是
    `agentDir` 被删掉的一个 Task 会带着**所有群里排队中的任务**一起死。
    AGENTS.md 对 dispatcher 明写 "a runtime that throws on `start()` must degrade to
    `failed`, never propagate"，而违背它的正是 runtime 自己。
    现在 `failRun()` 同时终止事件流（否则消费者的 `for await` 会永远等一个再也不会
    写字节的子进程），并给 `done` 挂兜底 handler；错误仍经 `settle()` 的 `error`
    监听器进入 `RunResult.error`，由 worker 记成该次运行 `failed`。
    真实端到端取证（真 API + 真 worker + 真模型，两个任务同一队列）：worker 进程
    存活、坏任务 `failed`、排在它后面的健康任务照常执行并真实发言。
    - **顺带修掉一条误导性错误**：Node 对"cwd 不存在"和"二进制不存在"给出**完全相同**的
      `ENOENT / syscall: "spawn pi" / path: "pi"`（实测）。原先的错误读起来就是
      "`pi` 没装"，于是排查从重装开始 —— 与 Q45 记过的"PATH 错配说成未安装"同一类
      误诊，这次也确实让我按错方向追了若干轮。现在 `spawnFailureMessage()` 按
      `cwd` 是否存在分叉：目录缺失就点名目录并指出 `room_agents.agent_dir`，
      目录在才说 `pi` 不在 PATH 上。诊断放在**错误出口**而不是 `start()` 预检：
      预检会拒掉大量单测用的合成 `agentDir`，把一个诊断变成行为变更。

17. **P9a 已落地，但入站入口没有鉴权**（2026-11-11）。`MTA_INGEST_ENABLED=1` 之后的
    `POST /api/ingest/events` 仍是**回环 + 静态令牌**的临时措施：`server.ts` 只绑 `127.0.0.1`，
    `MTA_INGEST_TOKEN` 是一个可共享的口令，不是身份。任何公网暴露必须先过 P7b。这是 PRD §7 明写的
    依赖关系，不是遗漏。
18. **`parallel>1`、`tell` 出站、预算熔断、执行隔离（P9d）都未做**。PRD §3 把它们列为 P9a 的非目标；
    `tell` 只落库不出站，`skill` 字段声明但 P9a 不消费（按约定标 `Seam:`），`parallel` 登记时拒绝非 1 值
    而不是收下不生效。**P9b/P9c/P9d/P9e 一行未写**。
19. **入站事件的速率/去重只在单进程内成立**。`rule_dispatches` 计数与 `lane_claims` 都在共享 SQLite 里，
    靠 `BEGIN IMMEDIATE` 串行；API 进程与 worker 进程若同时 `redriveDeferred`，会重复跑一次决策
    （幂等键兜住，不会多建 Task，但会多一次读）。P9a 单 worker 语境下不是问题，多 worker 需重看。
