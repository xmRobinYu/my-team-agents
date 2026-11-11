# PRD：事件入口与触发路由（P9 提案）

> 目标：把「任务的起点从人身上拿走」——让外部信号（告警、意见、定时、Webhook）
> 经统一事件契约进入系统，由声明式规则决定叫醒谁、在哪个工作区、用什么指令，
> 执行仍复用 P6 耐久内核。
> 状态：**P9a 已落地**（2026-11-11）。§8 的 D1-D6 已定案，见 `CONTEXT.md` Q49；Story 1–6
> 的验收标准全部勾选并有测试与真实进程证据。P9b/P9c/P9d/P9e 仍未开始（见 §10）。术语以 `CONTEXT.md` 词汇表为准。
> 灵感来源：卡兹克《折腾了整整 1 年，毫无保留地分享一下我这套 Agent 自动化系统》
> 与 `ref/AIHOT`（MIT，Copyright 2026 数字生命卡兹克）的对端实现。
> **本 PRD 不搬运两边代码，只采用其契约与语义。**

---

## 1. 背景与现状

### 1.1 我们缺的是上游，不是下游

P6/P7a/P8 已经把「任务被排队、执行、崩溃接管、按声明交接、按成员归因成本」做成了
可验证的闭环。但今天**每一个 Task 的起点都是人**：

| 现有入口 | 位置 | 起点 |
|---|---|---|
| `POST /api/tasks` | `packages/server/src/app.ts:66-83` | 人显式建任务 |
| `POST /api/rooms/:id/messages`（`@` 提及） | `packages/orchestrator/src/room-trigger.ts` | 人显式 @ |
| `/api/pi` 投影 | `packages/server/src/pi-routes.ts` | 人开线程、发第一条消息 |

没有任何一条路径能让「线上报错」「同事提了意见」「每天 08:00」自己变成一个 Task。
`product-plan.md` §5 把「任务 / 定时任务」标为 V1.5→V2，处置是「依赖持久化队列与
幂等；随后加调度器」——**前置条件今天已经成立，缺的正是后半句。**

### 1.2 具体缺口（读码所得，非推测）

1. **Task 不携带来源身份。** `CreateTaskInput`
   （`packages/orchestrator/src/execution-store.ts:22-41`）只有
   `prompt / model / groupId / agentDir / idempotencyKey`，没有
   `source`、`type`、`subject`、`link`。因此无法按事件类型路由、无法按对象聚类去重、
   无法「点开任务跳回当时的现场」。
2. **入站幂等没有闭环。** `tasks.idempotency_key` 是 `UNIQUE`
   （`execution-store.ts:161`），且 `insertTask` 命中已存在键时直接返回旧任务
   （`execution-store.ts:315-318`）——**机制现成**。但群聊入口自己写着
   「A repeated POST is a NEW message with new Tasks — there is no client idempotency
   key on this endpoint yet」（`room-trigger.ts:525-528`）。
3. **模板里的定时任务被丢弃。** `template-import.ts:714` 把 `categories` 与
   `cronTasks` 记入 `ignoredFields`（Q31 明确不在 V1 迁移）。丢弃是被记录的、
   诚实的；但**它们至今没有归宿**。
4. **通知只在浏览器开着时存在。** `notify()` 是进程内 SSE 广播
   （`app.ts:44`）。SSE 不是升级通道：没人订阅，就没有任何人知道 `blocked`。
5. **事件流与事件入口撞名。** 当前 `GET /api/events` 是任务流 SSE
   （`app.ts:136`）。新增入口**必须另起前缀**，否则同一个路径承载两种语义。

### 1.3 为什么不能直接照搬文章的那套

文章是**单人运维多产品**的系统：`rules.json` 一个文件、一个主人、一台 Mac。
我们是多租户平台。三条不可照搬：

| 文章做法 | 我们的约束 |
|---|---|
| 规则写在一个 JSON 文件里，改完即生效 | 规则必须带 tenant/project 作用域、可审计、可回滚；配置变更走 `CONTEXT.md`/门禁的精神（`AGENTS.md` 规则文件守卫） |
| 执行器是「主人自己的 Mac」 | `Q19`：一个项目工作区一个活跃 Worker；`Q23`：P7a 仅本机回环，**不可暴露到共享环境** |
| 「只在需要时弹卡片给我」 | 谁是「我」是租户问题，不是个人问题；升级对象与权限属 P7b |

---

## 2. 目标

| 编号 | 目标 |
|---|---|
| G1 | 一个外部生产者只需一次 `POST`，就能让系统里出现一个可执行、可追溯、可恢复的任务 |
| G2 | 「哪类事件交给谁、用什么指令」是**数据**，不是代码；改一行不改逻辑即可换 Agent |
| G3 | 同一件事被重复推送、被补充、被追问时，**不会**同时出现多个 Agent 在改同一对象 |
| G4 | 事件入口产出的任务与人工入口的任务共用同一内核：租约、fencing、重试、恢复、成本归因全部不变 |
| G5 | 事件的原始 payload 永不静默丢弃（与「未知事件不丢弃」同源原则） |

## 3. 非目标（P9a 明确不做）

- **鉴权、租户隔离、审计**（属 P7b，见 §7 的发布边界）。
- **真远程 runner**：执行器仍是同主机进程；本 PRD 只定义它的**契约**（§5.4），不实现跨机部署。
- **出站通知/飞书卡片/决策账本**：另见 P9b（依赖本文的 `tell` 字段）。
- **预算熔断、失败分类**：P9c。
- **执行隔离（容器/VM/出网策略）**：P9d，是 §6 Story 5 的硬前置。
- **不改现有群聊语义**：`groupId` 仍是 Room 语义（I3/I4/I6 已测），事件串行不复用它。

---

## 4. 参考事实

### 4.1 对端契约（AIHOT 已实现的生产者侧）

`ref/AIHOT/packages/backend/src/notify/agent.ts` 的 event 形状：

```ts
interface Event { id: string; type: string; subject: string; summary: string; detail: string; link: string }
```

其发送语义（可直接当作我们入口的兼容性要求）：

- 认证：`authorization: Bearer <WEBHOOK_HUB_KEY>`，`redirect: "error"`，15s 超时；
- **只认 HTTP 200**：`if (res.status === 200)` 才把本地回执标成 `accepted`；
- 落库幂等：`INSERT ... ON CONFLICT(key) DO NOTHING`，键是 `webhook.event.<sha256(id)>`；
  超时按「可能已送达」处理，**保留完全相同的持久化 id** 再试；
- `flushAgentEvents()` 只重投 `accepted=false` 的，已接收的绝不重派；
- 传输断了不阻塞自己的告警，而是产出一条 `Finding`（`agentTransportFindings`），
  并带一句「恢复之前，这些告警直接发给你」；
- 注释里明确让权：`Execution/claim/retry state belongs to the hub`（执行、领取、
  重试归中台，生产者一律不碰）。

> **兼容陷阱**：AIHOT 只认 `200`。我们的 API 惯例是 `201`（`app.ts:82`）。
> 入口若回 201，对端会认为没送达并无限重投。AC2.4 专门钉这一条。

### 4.2 文章的路由规则（要采纳的字段语义）

```jsonc
{ "name": "中台意见",
  "when": { "source": "virxact-hub", "types": ["feedback.new","feedback.followup","feedback.decided"] },
  "to": "m5-claude", "cwd": "~/code/work/virxact-hub", "skill": "hub-feedback",
  "ask": "按其中「被 Agent 自动化中台叫起来的」一节处理。",
  "group": "hub-feedback", "parallel": 3, "tell": "needed" }
```

拆成不变量：`when` 匹配是数据；`to/cwd/skill/ask` 决定执行身份与指令；
`group + parallel` 决定并发；`tell` 决定打扰；`dedup` 由 `subject` 承担（原文：
「每条意见单独开一轮，同一条意见同时只跑一轮，最多三条一起跑」）。

### 4.3 定时不是特殊路径

`ref/AIHOT/apps/worker/src/schedules.ts` 把定时做成**数据**：一项 `Scheduled` =
`{ name, cron, missed: "once", run }`，cron 按北京时间；`missed: "once"` 表示停机
漏掉的槽位只补一次（`reports.compose`、`ops.retention`、`seo.indexnow`、`ops.digest`
都是这一类）。每次运行经 `recordRun` 写一行 `job_runs`（`jobs/queue.ts:184-195`），
所以运维看得见「最近一次结果」。`operations/heartbeat.ts:8-14` 则把「进程还活着」
本身做成一行 `{pid, host, release, startedAt, at}`，供运行页与 watchdog 读。
文章的定时任务是同一件事：轮询是一种事件发现行为，**不需要第二套执行机制**。

---

## 5. 设计

### 5.1 事件契约（入站）

```ts
/** 归一后的入站事件。字段与 §4.1 对端兼容；未知字段一律保留，不丢弃。 */
interface InboundEvent {
  id: string;          // 生产者给的稳定 id；缺失时由 (source,subject,type) 导出
  source: string;      // 'aihot' | 'feishu' | 'cron' | ...
  type: string;        // 'alert.now' | 'feedback.new' | 'scheduled.daily' | ...
  subject: string;     // 对象键：同一 subject 的后续事件是接力，不是重复
  summary: string;     // 一句话，必填，截断 200
  detail?: string;     // 事实材料，截断 4000
  link?: string;       // 回到原处
  occurredAt?: number; // 生产者时间；缺则用到达时间
  payload?: unknown;   // 原始 body 原样落库（G5）
}
```

持久化两张新表（同一个 `ExecutionStore` 句柄、同一套事务风格，不引入新依赖）：

```
events(id PK, source, type, subject, summary, detail, link, occurred_at,
       arrived_at, payload JSON, dedup_key UNIQUE, outcome, task_ids JSON)
trigger_rules(id PK, tenant_id, project_id, name, enabled, priority,
              when JSON, to JSON, ask, skill, lane, parallel, tell, dedup JSON,
              created_at, updated_at)
```

`dedup_key` 取 `sha256(source + "\x1f" + id)`：这是**投递级**幂等，命中即返回已有
事件与其任务，绝不重派。

### 5.2 派发的三种结局（互斥，且都落库）

判定顺序是契约，不是实现细节（对齐 `room-guards.ts:32-41` 的「固定判定顺序」风格）：

```
1. delivered   —— 同 dedup_key 已存在 → 返回原事件与原 task_ids，不新建
2. coalesced   —— 同 (rule, lane, subject) 已有未完成 Task → 把本事件摘要追加进
                  该 Task 的上下文（复用 available_at 推迟），标 supersededBy
3. dispatched  —— 建新 Task
   3b. deferred —— 命中规则但超过该规则的 rate/parallel 上限 → 不丢弃，
                   写 available_at = now + retryDelay(...)，状态 deferred
```

**`coalesced` 是文章第三条好处（去重/补充意见/贴图）的落点**，也是与「每来一条就
叫醒一次」的本质区别。它今天做不到，因为 Task 没有 `subject` 可以比对。

### 5.3 串行 lane ≠ groupId（必须分开）

`claimNext` 已经实现「同 `groupId` 严格串行」（`execution-store.ts:448-453` 的
`NOT EXISTS`，`group-serial.test.ts` 用两个 Worker 证伪过）。但 `groupId` 在 P8
已承载三重语义：Room 查找（`getRoom(task.groupId)`）、I4 群历史注入、
**Q31 强制不续会话**。事件的串行组若复用 `groupId`，会得到：

- 没有 Room 行 → 群历史注入静默失效，看起来「能跑」；
- 更糟的是 `durable-worker.ts:616` 会因此强制 `resumeSession = false`，
  非群聊任务的 Q18 续会话行为被连带改变。

因此新增 `CreateTaskInput.lane`，并把 `claimNext` 的排除键改成
`COALESCE(lane, group_id)`——**Room 行为逐字节不变**（AC3.3 用现有测试守着），
事件路径获得同样的串行保证。

`parallel` 在 P9a 只允许 `1`。要放开必须同时改 `claimNext` 的计数逻辑，
并撤销 `group-serial.test.ts` 的「峰值并发 1」断言——**这是一次语义变更，
不是加个字段**。规则登记时 `parallel > 1` 直接拒绝，而不是收下后不生效。

### 5.4 领取契约（为远程执行留形，不实现部署）

`DurableWorker.runOnce()` + `store.claimNext(workerId, now, leaseMs)`
（`execution-store.ts:441`）+ `heartbeat`（`:472`）+ `recoverExpired`
已经是文章那套「接单程序」的完整机制，只是现在读的是共享 SQLite 文件。
P9a 把它显式化为可跨进程的形状（HTTP 或同进程调用皆可）：

```
claim(workerId, caps)  -> { task, attempt, fencingToken } | null
heartbeat(attemptId, fencingToken)
complete(attemptId, fencingToken, result | failure)
```

**远程执行器的前置不在这个 PRD 里**，缺的是两样硬条件：
`POST /api/tasks` 今天对 `tenantId/projectId/memberId/workspacePath` 一律接受、
无任何鉴权（`app.ts:66-83`，`server.ts:23` 只绑 `127.0.0.1`）；
`workspacePath/agentDir` 是**本机文件路径**。把领取暴露到别的机器，等于把
「任意入队 + 任意 cwd」交给不可信来源。所以：契约先对，部署等 P7b + P9d。

### 5.5 规则命中产出的 Task

复用 `createTask`，因此重试/租约/恢复/成本归因自动生效。字段映射：

| 规则字段 | Task 字段 | 说明 |
|---|---|---|
| `to.memberId` | `memberId` | 登记时校验存在，见 AC1.3 |
| `cwd` | `workspacePath` | 必须是该 project 已登记的工作区，不接受任意路径 |
| `lane` | `lane` | 串行组 |
| `ask` + 事件摘要 | `prompt` | 指令在前、数据在后，数据块显式标注不可信（Story 5） |
| `idempotencyKey` | `event:<eventId>` 或 `evt:<ruleId>:<subject>:<attempt>` | 复用 §5.1 |
| `tell` | 记在事件行上 | P9a 只落库，不出站（P9b） |

`skill` 在 P9a 是**声明但不生效**的字段，按 `AGENTS.md` 约定标 `Seam:`，
指向 I9 的技能目录（`orchestrator/src/skills.ts`）。

---

## 6. 用户故事与验收标准

### Story 1 — 事件进得来

> 作为生产者，我 POST 一条事件，系统里就出现一个可执行任务，且我能看到它是怎么被
> 决定交给谁的。

- [x] AC1.1 `POST /api/ingest/events`（Bearer 令牌 + `redirect: "error"`）写入
      `events` 并返回事件行；未知字段原样保留在 `payload`（G5）
- [x] AC1.2 没有任何规则命中时，事件仍落库并记 `unmatched`，**不静默丢弃**；
      响应里能查到命中的 ruleId 列表
- [x] AC1.3 规则引用的 `memberId` 不存在时，**登记时**就拒绝（不是运行时静默降级）。
      依据：模型给的自由字符串直进派发曾经产出 `member_id="寇豆码"`、
      `agent_dir=NULL`、`model=NULL` 却在项目工作区里空转的任务
      （`durable-worker.ts:270-278` 记的是真实验收跑出来的缺陷）
- [x] AC1.4 单测：命中/未命中/多命中按 `priority` 取序/目标不存在四类

### Story 2 — 重复不炸

> 作为使用者，我不希望网络抖一下就有三个 Agent 同时改同一条意见。

- [x] AC2.1 同 `dedup_key` 重投 N 次只产生 1 个事件行、1 批 Task
- [x] AC2.2 同 `(rule, lane, subject)` 且前一个 Task 未结束时来新事件：
      `coalesced`，不新建第二个 Task
- [x] AC2.3 `coalesced` 可查询：旧 Task 上能看到被并入的事件 id 列表
- [x] AC2.4 **重复投递返回 200，不是 409**，且响应带原 `task_ids`
      （对端只认 `res.status === 200`，见 §4.1 陷阱）
- [x] AC2.5 超速率/并发上限时走 `deferred`，事件行状态可见，绝不消失

### Story 3 — 内核不变

> 作为平台，事件触发的任务必须与人工触发的任务享有同一套耐久保证。

- [x] AC3.1 事件触发的 Task 走 `ExecutionStore.createTask`，具备
      租约 / fencing token / ≤3 次自动重试 / 退避（`retryDelay`，Q37）
- [x] AC3.2 同 `lane` 串行：两个 Worker 并发领取时峰值并发为 1
      （照 `group-serial.test.ts` 的证伪法写）
- [x] AC3.3 **现有 Room 行为不变**：`group-serial.test.ts`、
      `room-trigger.test.ts`、`room-reply.test.ts`、`recovery.test.ts` 全绿且
      未修改断言（lane 改动不得动摇 `COALESCE` 之前的 Room 分支）
- [x] AC3.4 事件触发的非群任务仍可按 Q18 续会话（不得因 `lane` 改动被连带禁掉）

### Story 4 — 定时即事件

> 作为使用者，我希望「每天 08:00 跑一次」也是一条事件，而不是第二套执行机制。

- [x] AC4.1 `cron` 源按 §4.3 产生事件：纯时钟驱动，不按数据量判断
- [x] AC4.2 同一天重复触发幂等（北京时间自然日），停机漏掉会补
- [x] AC4.3 团队模板导入的 `cronTasks` 从此**转成规则**而不是进
      `ignoredFields`（`template-import.ts:714`）；转不动的仍记录、不静默
- [x] AC4.4 单测：同一 tick 跑两次只入队一次；跨日重新入队

### Story 5 — 不可信内容不越权（P9a 的硬边界）

> 作为平台，事件正文来自外部生产者，而 Agent 手里有 `write` / `bash`。

- [x] AC5.1 注入 prompt 时，事件 `summary/detail` 落在显式标注的数据块内，
      指令只来自规则 `ask`；两者不同源、不拼接成一段
- [x] AC5.2 P9a 的规则只能指向「只读/诊断/汇总」类目标：目标 agent 的
      可写工具配置在 P9d 隔离落地前**拒绝登记**
      （依据：Pi 的 `capabilities` 里 `sandbox === "none"`、`approval === "none"`
      ——`runtime-core/src/adapter.ts:26-28` 声明了这两个取值；适配器又显式传
      `--approve`，因此信任不约束工具能力）
- [x] AC5.3 入口默认只绑 `127.0.0.1`，令牌写在配置里、不入事件行
- [x] AC5.4 事件正文进日志前脱敏/截断；不记录密钥（对齐 AIHOT
      「never log payloads or errors: they can contain credentials」的取舍）

### Story 6 — 可追溯

> 作为复盘的人，我要能从「一条告警」走到「哪个 Agent、干了什么、结论是什么、
> 花了多少」。

- [x] AC6.1 `GET /api/ingest/events/:id` 返回事件、命中规则、产出 Task、
      每 Task 的 usage 合计
- [x] AC6.2 `link` 原样保留，可直接跳回现场
- [x] AC6.3 `GET /api/ingest/stats`：按 source/type/rule 的事件数、
      派生 Task 数、成功率、token 与成本 —— 文章说的「数据沉淀」，
      数据源就是我们已有的 `usage` 表

---

## 7. 发布边界与依赖

| 依赖 | 状态 | 关系 |
|---|---|---|
| P8 收尾（I7–I10） | 进行中 | 不阻塞 P9a 设计，但共享 `claimNext`，改动需串行合入 |
| **P8 补丁**：`thinkingMode` 断链 | **已做**（2026-11-10） | `RoomAgent.thinkingMode` 原先只到数据库与模板，`durable-worker` 构造 `RunSpec` 时不带它，于是群声明 `thinkingMode: "high"` 也白声明。现由 `personaThinking()` 在每次运行时按 `task.memberId` 从花名册派生（不改表：`tasks` 没有该列，加列要手写 `ALTER TABLE`；派生还有个额外好处 —— `dispatchInput` 派出的子 Task 在 `execute` 里同样生效，用的是**子自己**的人设而非父的）。取值按 Pi 的闭合集合收紧（`off/minimal/low/medium/high/xhigh/max`），集合外一律丢弃：`thinking_mode` 是 `TEXT` 且来自模型写的团队模板，原样透传等于让模板控制一个命令行 token。代价是编辑 `thinking_mode` 从下一次触发生效（含重试），与人格技能在 spawn 时读取的规则一致。证据：`packages/orchestrator/src/thinking-mode.test.ts` 5 条（含撤掉接线后必需变红的证伪）；真实链路复跑一次真 worker + 真 `PiAdapter`，捕获到的子进程 argv 含 `--thinking high` |
| P7b 鉴权/租户隔离/审计 | 待启 | **AC5.3 只是回环 + 静态令牌的临时措施**。任何公网暴露必须先过 P7b |
| P9d 执行隔离 | 未做 | AC5.2 的放行条件 |
| P9b 升级与决策账本 | 未做 | 消费本文的 `tell` 字段 |

**入口本身就是攻击面**：这条链路第一次让外部字节进入系统，所以 §6 Story 5 不是可选项。
`constraints.yaml` 现已补上 `ingest_limits`（见该文件）——因为"外部字节进得来"这件事此前
在约束里**没有**任何对应声明。唯一的凭据曾是 `server.ts` 把监听绑在 `127.0.0.1` 加上 Q23
的口头发布边界；现在多了三条**可执行**的：登记时拒绝可写工具（AC5.2，且清单真的进
`--tools`）、入站字段强制截断（`summary`≤200 / `detail`≤4000）、入口默认关 + 可选令牌。
仍然**不是鉴权**，公网暴露必须先过 P7b。

## 8. 待确认决策（不代使用者决定）

| # | 问题 | 选项 |
|---|---|---|
| D1 | 规则存哪里 | A 只有 SQLite 表 + API；B 表 + `rules.json` 单向导入（Git 可审）；C 只有文件 |
| D2 | 事件与 Task 的表关系 | A `events` 新表 + `tasks` 加 `event_id/lane/source`；B 全塞进 `tasks` 新列 |
| D3 | 一条规则可否命中多 Room | A 一规则一目标；B 一规则多目标（并发语义变复杂） |
| D4 | 定时实现位置 | A 服务进程内定时器（对齐 §4.3 的 `missed: "once"` 幂等）；B 独立 scheduler 进程（AIHOT 把定时权交给 worker 单进程，`queue.ts:61-62`）；C 外部 cron `POST` |
| D5 | `lane` 与 `parallel` 是否 P9a 就分开 | A 分开且 `parallel` 只允许 1；B 允许 N（需改 `claimNext` 计数 + 撤现有断言） |
| D6 | 入口是否默认开启 | A 默认关，环境变量显式打开（对齐 AIHOT「安全阀只有 `true` 才打开」）；B 默认开 |

## 9. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 入口 + 无鉴权 + 任意 `workspacePath` 同时成立 | 任何能连回环的进程可指挥 Agent 改任意目录 | Story 5 全部条款；默认关（D6/A）；仅回环 |
| 事件风暴（生产者重试、告警刷屏） | token 与队列被打满 | `dedup_key` + `coalesced` + `deferred`；注意既有护栏（fanout 20 / depth 100 / chain budget 20，`domain/src/handoff.ts:17-22`）**只约束交接链，每个事件开新链，因此完全拦不住入口**——这正是必须有 `deferred` 的原因 |
| `coalesced` 把不相关信息拼进同一上下文 | 模型行为不可预期 | 拼接顺序固定 + 每条带事件 id 与来源；可被 AC2.3 审计 |
| 定时与外部源同路径后难排障 | 「谁触发了这个任务」变模糊 | `source` 必落库；AC6.1 反查 |
| 迁移成本：`node:sqlite` 实验性 + 无迁移工具 | 加两张表再次手写 `if-not-exists` | 与「先补最小迁移账本」的独立小 PR 一起做（`execution-store.ts:223-229` 的列补丁即技术债） |
| 与 P8 抢 `claimNext` | 串行化保证被削弱 | AC3.2/AC3.3 双测；lane 改动单独一个 PR |

## 10. 分期

| 期 | 内容 | 关键验收 |
|---|---|---|
| **P8 补丁** | ~~接通 `thinkingMode → RunSpec.thinking`~~（**已做** 2026-11-10）；~~最小迁移账本~~（**已做** 2026-11-11：`schema_migrations` + `applyMigrations`） | 一条测试证明 `--thinking` 真的进了 argv —— 已满足（`thinking-mode.test.ts`） |
| **P9a** | **已做** 2026-11-11：`inbound_events`（**不叫 `events`**，与持久化日志撞名）+ `trigger_rules` + `lane_claims`/`rule_dispatches`/`event_coalesce`、`POST /api/ingest/events`、四种结局、`lane` 串行 | Story 1–3 全绿；对端兼容 200（AC2.4） |
| **P9.5** | **已做** 2026-11-11：`cron` 是规则上的数据，tick 产出 `source:"cron"` 事件；`just verify-import` 增补 AC4.3 证据段（真实包 `Git周月报` 2 条 cron 全部转成规则、0 具名拒绝） | Story 4 全绿；真实模板导入回归不劣化 |
| **P9b** | 消费 `tell`：升级对象、分级、冷却、单一出站通道（飞书卡片）、决策账本 | 「定过的事不问第二遍」可证伪 |
| **P9c** | 预算熔断 + 失败分类（`error_kind`） | 超限进 `blocked` 而非 `failed` |
| **P9d** | 执行隔离（容器/只读档/出网策略） | 放行 AC5.2 |
| **P9e** | 真实对端联调：把 `ref/AIHOT` 的 `WEBHOOK_HUB_URL` 指到我们的入口 | 一条真实告警 → 一个 Task → `GET /api/ingest/events/:id` 全程可查；重发 3 次仍只有 1 个 Task |
