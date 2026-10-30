# PRD：多 Agent 群聊工作台（V1）

> 目标：复刻 teamagentx 的多 agent 群聊体验与团队模板生态，前端基于
> `@assistant-ui/react-pi`，后端复用本项目已落地的 P6 持久化执行内核。
> 决策来源：`CONTEXT.md` Q28–Q35。术语以 `CONTEXT.md` 词汇表为准。

---

## 1. 背景与目标

### 1.1 现状

P6（持久化队列）与 P7a（服务端 API + assistant-ui 工作台）已完成并通过门禁：

- `ExecutionStore` 用 SQLite 持久化 Task / Attempt / Event / Usage / 交接 outbox；
- 租约 + fencing token，崩溃恢复，每批次最多 3 次 Attempt；
- 服务端 Fastify API + SSE，Worker 独立进程；
- UI 已全面改用 `usePiRuntime`，经 `/api/pi` 投影层连接服务端。

**但当前工作台是单 agent 会话**：`Task == Thread` 一对一。没有群、没有多 agent、
没有角色模板。这是 V1 要补的部分。

### 1.2 目标

| 编号 | 目标 |
|---|---|
| G1 | 导入一个 teamagentx 团队模板包，直接得到一个可用的多 agent 群 |
| G2 | 群里多个 agent 各有独立人格，@谁谁回应，消息流带作者身份 |
| G3 | agent 之间可以自动接力（auto 模式），但不会失控循环 |
| G4 | 视觉与交互对齐 teamagentx：三栏布局、多 agent 头像、@输入 |
| G5 | 群状态、轮次、终止态全部持久化，崩溃不丢 |

### 1.3 非目标（V1 明确不做）

- `cronTasks`（定时任务）与 `categories`（分类）——模板包里有，但不迁移（Q31）
- 鉴权、租户隔离、审计（P7b）
- 任务面板（task-board / task-queue / history）
- 3D 办公室、设置页、移动端
- 扇入聚合窗口、工具白名单（teamagentx 自己也是推迟项）

---

## 2. 术语

| 术语 | 含义 | 来源 |
|---|---|---|
| ChatRoom | 承载共享消息流、规则与自身 agent 集合的**实体** | Q33 |
| Group | 项目之上的协作**视图**。视图不承载消息 | 词汇表 |
| Agent persona | 一个 agent 的身份：独立 agentDir（cwd + skills + AGENTS.md）+ 角色 prompt | Q29 |
| Round | 一次 agent 触发（@ 或工具）。轮次上限约束 agent 间对话 | Q30 |
| Coordinator | 模板包指定的收尾者，轮次超限时强制汇总 | Q30 |
| Team template | 导入整个 ChatRoom 的包：群名 + 规则 + N 个 agent + 技能 | Q28 |

> **注意**：`Group` 与 `ChatRoom` 是两个不同概念。历史上 `Group` 被定义为视图，
> 视图无法承载消息流，因此引入 `ChatRoom` 而非扩展 `Group`（Q33）。

---

## 3. 参考事实（调研所得，非推测）

### 3.1 团队模板包的真实结构

`ref/teamagentx-templates/` 有 32 个包（全栈软件研发、SEO-内容营销、A股研究团队…）。
每个 zip 含：

```
manifest.json              包元信息
snapshot.json              实际内容
capability-descriptors.json
skill-usages.json
degraded-skills.json
```

`manifest.json`：

```json
{
  "schemaVersion": "1.0",
  "templateId": "tpl-room-4061951d-...",
  "version": "1.0.0",
  "title": "全栈软件研发",
  "contents": { "group": true, "agents": 5, "categories": 1, "skills": 0, "cronTasks": 0 }
}
```

`snapshot.json` 顶层：`room` / `agents` / `categories` / `cronTasks`。

`room`：`id`、`name`、`description`、`rules`（Markdown，含团队简介、成员名单、快捷场景）。

`agents[]` 每项字段：
`id`、`name`、`prompt`（含 YAML frontmatter：name/description/color/emoji/vibe）、
`type`、`acpTool`、`categoryId`、`workDir`、`proxyConfig`、`codexModel`、
`codexFastMode`、`claudeModel`、`thinkingMode`、`llmProviderId`、`speechConfig`、
`capabilities`。

例：`全栈软件研发` = room「全栈软件研发」+ 5 个 agent
（齐活林/交付总监、许清楚/产品经理、高见远/架构师、寇豆码/工程师、严过关/QA）。

### 3.2 teamagentx 前端形态

React + react-router + zustand + Socket.io + Radix/Tailwind（shadcn）。
三栏：会话列表 / 聊天区 / 侧边面板（agents、task-board、task-queue、history）。
关键组件：`chat-area.tsx`、`chat-message.tsx`、`mention-input.tsx`、
`agent-avatar.tsx`、`conversation-list.tsx`、`assistant-page.tsx`。
许可为 **MIT**（Copyright 2026 dbfu），复制 UI 结构允许；若搬运代码需保留署名。

### 3.3 teamagentx 的群聊流程控制

其 `specs/multi-agent-interaction/requirements.md` 定义三个守卫：

| 守卫 | 行为 |
|---|---|
| 循环检测 | A→B→A，链中出现重复 agent 即阻断，并发系统消息 |
| 轮次上限 | `maxAgentRounds` 默认 5，超限注入强制收尾指令给协调者 |
| 终止信号 | 协调者输出 `[讨论结束]`，代码层标记该群 terminated |

**关键差异**：上游用**内存 Map** 存这些状态，其 AC3.4 明确「服务重启视为非
terminated，可接受」。我们不继承这个缺陷——状态落 SQLite（Q28/Q29）。

### 3.4 上游已知问题（我们要避免）

其需求文档自述的生产问题：

- A→B→A 无限循环，token 飙升，永不收尾；
- 协调者 @3 个助手后被触发 3 次，形成 3ⁿ 消息爆炸；
- `[讨论结束]` 文档设计了但代码没实现。

根因：把确定性的终止责任委托给了 LLM。我们的守卫必须在代码层（这也是 Q15
「settle 后派发」已有的立场）。

---

## 4. 架构决策

### 4.1 前端

- 继续用 `@assistant-ui/react-pi` 的 `usePiRuntime`（Q27 已落地）。
- **一个 ChatRoom = 一个 PiClient thread**（Q29）。共享消息流是该 thread 的消息序列，
  每条消息带作者（user 或某个 agent）。
- 三栏布局：会话列表 / 群聊区（多 agent 头像 + `@` 输入）/ 成员面板。
- 技能管理 UI 在 V1 范围内（Q32/Q33），会额外增加一个页面。

### 4.2 后端

**移植协作语义，不照搬实现**（Q28）。

| 维度 | teamagentx | 我们 |
|---|---|---|
| 传输 | Socket.io | SSE（Q22 已定，已实现） |
| 存储 | Prisma | SQLite `ExecutionStore`（P6 已落地） |
| 群/轮次/终止态 | 内存 Map，重启即丢 | 持久化，崩溃可恢复 |
| 队列 | 其自研 | 复用 P6 durable queue（租约/fencing/重试） |

不引入 Socket.io，不废弃 P6。

### 4.3 人格隔离

每个 agent 有**独立 agentDir**（cwd + skills + AGENTS.md），会话也按 agent 隔离（Q29）。

> **修正一条既有记录**：`runtime-core/src/adapter.ts:66` 的注释称 `agentDir`
> 「被上游阻塞」。该约束只适用于 react-pi 的 `createPiNodeClient` supervisor，
> 而我们不用它——`PiAdapter` 自己 `spawn("pi", args, { cwd })`。因此 agentDir、
> skills、session dir 都可由我们按 run 设置。已核实 Pi CLI 支持 `--skill`、
> `--append-system-prompt`、`--session-dir`、`--extension`、`--no-context-files`。
> 该注释需在 P8 落地时修正。

### 4.4 上下文与执行

- **不续 Pi 会话**（Q31）。每次触发启动干净 Pi 进程，注入完整群历史（含其他
  agent 的发言）+ 自身角色 prompt。
  - 避免历史被注入两遍（群历史 + 自身会话）；
  - 副作用：崩溃恢复变简单——重放同一份注入即可，无需恢复 Pi 内部状态。
  - 这收窄了 Q18「恢复原会话」在群聊路径的适用；会话恢复仍是 Pi adapter 能力，
    但群聊不用它。
- **同群串行**（Q31）：一个 agent 跑完再下一个。不并发。
  - 与现有 Worker 天然契合：`runOnce()` 每次 `claimNext()` 领一个任务执行
    （`durable-worker.ts:248-252`）。
- **轮次定义**（Q30）：一次 agent 触发 = 一轮。

### 4.5 触发与派发

- **auto 模式**（Q34）：agent 消息可触发其他 agent。因此循环检测与轮次上限是
  真需求。
- **两条派发路径都识别，`handoff_to` 优先**（Q34，修订 Q14）：
  - 主路径：结构化 `handoff_to` 工具；
  - 次路径：agent 消息中的 `@name` 文本。
  - **按目标去重**（Q35）：同一目标在同一条源消息中最多入队一次。
    `handoff_to` 与 `@` 指向不同目标时都生效。
- **@提及 → Task**（Q29）：用户 @A 即为 A 生成一个 Task 进入 P6 队列，
  天然获得重试/租约/恢复。

### 4.6 ChatRoom 归属

ChatRoom 属于某个 Project，共享其工作区；导入的 agent 成为该项目成员（Q34）。
与词汇表「agent 绑定一个 project」一致。

---

## 5. 用户故事与验收标准

### Story 1 — 导入团队模板

> 作为使用者，我想导入一个 teamagentx 团队模板包，立刻得到一个配置好的多 agent 群，
> 以便不必手工创建每个角色。

- [ ] AC1.1 导入 zip 后，解析 `manifest.json` + `snapshot.json`，创建一个 ChatRoom
      （名称、描述、rules 来自 `room`）
- [ ] AC1.2 为 `agents[]` 每一项创建成员与独立 agentDir（含 prompt、skills、AGENTS.md）
- [ ] AC1.3 `room` 中指定的协调者被标记为 Coordinator
- [ ] AC1.4 导入失败的包（缺文件、schema 不匹配）给出明确错误，不留半成品
- [ ] AC1.5 至少用 1 个真实包（全栈软件研发）端到端验证通过

### Story 2 — 群内 @提及触发

> 作为使用者，我在群里 @某个 agent，希望只有它被触发并回复，且回复带它的身份。

- [ ] AC2.1 @A 后仅为 A 生成一个 Task，其他 agent 不触发
- [ ] AC2.2 A 的回复在共享消息流中显示，带 A 的头像与名字
- [ ] AC2.3 A 收到的上下文包含完整群历史（含其他 agent 的发言）与其角色 prompt
- [ ] AC2.4 同时 @A @B，按串行顺序执行，不并发
- [ ] AC2.5 被 @的 agent 名不存在时，给出提示而非静默失败

### Story 3 — agent 间自动接力

> 作为使用者，我希望 agent 之间能自动交接，不需要我手动中转。

- [ ] AC3.1 agent 通过 `handoff_to` 派发时，目标 agent 被入队执行
- [ ] AC3.2 agent 消息中的 `@name` 文本也能触发目标 agent
- [ ] AC3.3 同一条消息中 `handoff_to` 与 `@` 指向同一目标时，只触发一次
- [ ] AC3.4 交接链受既有护栏约束（fanout ≤ 20、depth ≤ 100、budget ≤ 20、revisit ≤ 5）

### Story 4 — 循环检测

> 作为使用者，我不希望两个 agent 无限互 @，烧掉我的 token。

- [ ] AC4.1 A→B→A 时，第二次对 A 的触发被阻断，并在流中显示系统消息
- [ ] AC4.2 用户发送新消息后，对话链重置，A 可再次被触发
- [ ] AC4.3 合法链路（用户→A→B→协调者）不被误判

### Story 5 — 轮次上限

> 作为使用者，我希望群聊在可预期步数内收敛，即使 agent 达不成共识。

- [ ] AC5.1 轮次达到上限（默认 5）时，向 Coordinator 注入强制收尾指令
- [ ] AC5.2 超限后不再处理新的 agent 触发
- [ ] AC5.3 用户发送新消息后轮次计数重置
- [ ] AC5.4 上限可按 ChatRoom 配置

### Story 6 — 终止信号

> 作为使用者，协调者宣布结束后，群应真正停下。

- [ ] AC6.1 Coordinator 消息含 `[讨论结束]` 时，该 ChatRoom 标记 terminated，阻断后续触发
- [ ] AC6.2 非 Coordinator 的 `[讨论结束]` 被忽略并记录 warn
- [ ] AC6.3 terminated 状态下用户发新消息，状态重置
- [ ] AC6.4 **terminated 状态持久化**：进程重启后仍保持 terminated（不同于上游内存实现）

### Story 7 — 崩溃不丢

> 作为使用者，我希望进程崩溃后群聊状态不丢，未完成的 agent 任务继续执行。

- [ ] AC7.1 轮次计数、对话链、terminated 状态均落 SQLite
- [ ] AC7.2 Worker 崩溃后重启，未完成 Task 被重新领取并执行
- [ ] AC7.3 重复执行不产生重复计费（fencing token 拒绝旧 Attempt 迟到写入）

### Story 8 — 技能管理

> 作为使用者，我想查看与管理 agent 的技能。

- [ ] AC8.1 可查看每个 agent 已安装的技能列表
- [ ] AC8.2 技能随 agentDir 落地，执行时通过 `--skill` 注入
- [ ] AC8.3 可安装/卸载技能

### Story 9 — UI 形态

> 作为使用者，我希望界面与 teamagentx 一致，降低迁移成本。

- [ ] AC9.1 三栏布局：会话列表 / 群聊区 / 成员面板
- [ ] AC9.2 群聊区每条消息显示作者头像与名字，不同 agent 视觉可区分
- [ ] AC9.3 输入框支持 `@` 唤起成员选择
- [ ] AC9.4 成员面板展示群内 agent 及其角色

---

## 6. 验收门禁（V1 完成的定义）

在**真实模型**下（非 mock）跑通：

1. 导入 `全栈软件研发` 团队包，得到含 5 个 agent 的 ChatRoom；
2. 用户 @架构师，架构师以自身身份回复，且明显使用了群上下文；
3. agent 间发生一次自动交接；
4. 人为制造 A→B→A，循环被阻断；
5. 达到轮次上限，Coordinator 强制收尾；
6. 杀掉 Worker 进程后重启，未完成 Task 继续执行，无重复计费。

`just check` 全绿；新增测试覆盖守卫与导入解析。

---

## 7. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 注入完整群历史导致 token 成本随轮次增长 | 长对话成本高 | 串行执行已限制并发；后续可加窗口/摘要 |
| auto 模式仍有失控可能 | token 不可控 | 三守卫 + 既有护栏；默认上限 5 |
| 团队包字段与我们的模型不匹配（如 `codexModel`、`acpTool`） | 导入失败或语义丢失 | 解析时显式忽略未知字段并记录，不静默吞掉 |
| 技能管理 UI 扩大 V1 范围 | 交付周期变长 | 已确认在范围内（Q33）；必要时可拆为 1a/1b |
| 照搬 UI 的许可与署名 | 法律风险 | 上游为 MIT，搬运代码需保留署名与 NOTICE |
| `node:sqlite` 实验性 | 升级 Node 可能行为变化 | P7b 前复核（Q19 已记） |

---

## 8. 开放问题

- 群历史的注入格式：纯文本拼接还是结构化角色标注？影响模型对"谁说了什么"的理解。
- 长群历史的上限与截断策略（本期未定，串行 + 默认 5 轮暂时兜住）。
- 32 个包中部分含 `speechConfig`、`proxyConfig` 等我们不迁移的字段，需确认忽略清单。
