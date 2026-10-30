# Issue 拆分：多 Agent 群聊工作台（P8）

> 来源 PRD：`docs/prd/multi-agent-group-chat.md`。决策：`CONTEXT.md` Q28–Q35。
> 切片原则：每个 issue 是一条**垂直 tracer bullet**，穿透需要的层并可独立验证；
> 不做「先建数据库层」这类横向杂活（除非该层本身即交付物）。

## 验证接缝（按优先级）

1. **业务流**：真实模型下端到端跑通（`@提及 → 执行 → 守卫 → 恢复`）
2. **服务边界**：`/api/rooms`、`/api/pi` 路由与 SSE
3. **领域边界**：`ChatRoom` 状态机、守卫判定（纯函数）
4. **单测**：解析、去重、守卫

现有命令：`just check`（build→typecheck→test→verify-cli→test-guardrails→verify-docs→verify-packages）、
`just test-no-build`、`just pi-smoke`。

## 依赖顺序

```
I1 领域与持久化 ──> I2 模板导入 ──> I3 触发与执行 ──> I5 守卫
                                        I4 群历史注入 ─┘
                                                      ──> I6 /api/pi 投影 ──> I7 UI 三栏 ──> I8 技能 UI ──> I9 端到端
```

---

## Issue: I1 — ChatRoom 领域模型与持久化
Type: AFK
Blocked by: None
User stories covered: Story 1（部分）、Story 7

### What to build
引入 `ChatRoom` 实体与持久化表，与 `Group`（视图）分离。新建
`packages/domain/src/chat-room.ts` 与 `packages/orchestrator/src/room-store.ts`。
表：`chat_rooms`、`room_agents`、`room_messages`、`room_state`。

`chat_rooms`: id, project_id, name, description, rules, coordinator_agent_id,
max_rounds(default 5), created_at
`room_agents`: id, room_id, name, role, prompt, agent_dir, model, thinking_mode,
emoji, color, is_coordinator, created_at
`room_messages`: id, room_id, seq, author_kind(user|agent|system), author_agent_id,
content, task_id, created_at
`room_state`: room_id PK, round_count, chain TEXT(JSON), terminated INTEGER, updated_at

### Acceptance criteria
- [ ] `ChatRoom` 在 `packages/domain/src/chat-room.ts` 定义并从 index 导出
- [ ] 四张表在 store 初始化时创建
- [ ] 群状态（round_count / chain / terminated）可读写且**落库**
- [ ] 单测：状态读写往返；terminated 持久化后重开仍为 terminated

### Validation
- Command: `pnpm test`（新增 `room-store.test.ts`）
- Evidence: 用例通过；`just test-no-build` 退出码 0

### Notes
- 复用现有 `ExecutionStore` 的 SQLite 连接与事务风格，不引入新依赖
- `Group` 语义不变（仍是视图），不要复用它承载消息

---

## Issue: I2 — 团队模板包解析与导入
Type: AFK
Blocked by: I1
User stories covered: Story 1

### What to build
解析 teamagentx 模板 zip（`manifest.json` + `snapshot.json` +
`capability-descriptors.json` + `skill-usages.json`），创建 ChatRoom 与
room_agents，并为每个 agent 生成独立 agentDir（含 AGENTS.md 与 skills）。
暴露 `POST /api/rooms/import`。

### Acceptance criteria
- [ ] 解析 `全栈软件研发` 包：room + 5 agents 正确落成
- [ ] 每个 agent 生成独立 agentDir（cwd + skills + AGENTS.md）
- [ ] `room` 指定的协调者被标记 `is_coordinator`
- [ ] 缺文件 / schema 不匹配 → 明确错误，**不留半成品**（事务回滚）
- [ ] 不迁移 `cronTasks` / `categories`；未知字段（`speechConfig`、`proxyConfig`、
      `codexModel`、`acpTool`）显式忽略并记录，不静默吞掉
- [ ] 单测：正常包、缺 manifest、坏 JSON、无协调者

### Validation
- Command: `pnpm test`（`template-import.test.ts`）+ 导入真实包后 `GET /api/rooms`
- Evidence: 测试通过；真实包导入返回含 5 个 agent 的 room

### Notes
- 参考 `ref/teamagentx-templates/全栈软件研发-2026-06-03.zip`
- Node 内置无 zip 解析；用 `fflate`（极小）或 `unzip` 系统调用。优先 `fflate`

---

## Issue: I3 — @提及触发与人格执行
Type: AFK
Blocked by: I1, I2
User stories covered: Story 2

### What to build
用户消息中的 `@name` 解析出目标 agent，为每个目标生成一个 Task 进入 P6 队列。
执行时以该 agent 的 agentDir 为 cwd 启动 Pi（不续会话）。

### Acceptance criteria
- [ ] `@A` 仅为 A 生成一个 Task，其他 agent 不触发
- [ ] 执行以 A 的 agentDir 为 cwd
- [ ] 同群串行：同时 @A @B 时不并发
- [ ] @不存在的 agent → 明确提示，非静默失败
- [ ] 单测：@解析（含重名、@全体、行内 @）、目标→Task 映射

### Validation
- Command: `pnpm test`（`mention.test.ts`）
- Evidence: 用例通过；mock 下 @A 仅产生 1 个 Task

### Notes
- 复用 P6 `store.enqueue` / `claimNext`，不新建队列
- `PiAdapter` 已用 `cwd: spec.workspacePath`；agentDir 需接入 `RunSpec.agentDir`

---

## Issue: I4 — 群历史注入
Type: AFK
Blocked by: I3
User stories covered: Story 2（AC2.3）

### What to build
触发 agent 时，把该群的完整消息历史（含其他 agent 发言）与角色 prompt
注入 Pi 进程。**不续 Pi 会话**（Q31），避免历史注入两遍。

### Acceptance criteria
- [ ] 注入内容含群历史全部消息，标注每条的作者
- [ ] 注入内容含该 agent 的角色 prompt
- [ ] 不使用 `--session` 续跑（群聊路径）
- [ ] 单测：注入文本结构；确认未传 `--session`

### Validation
- Command: `pnpm test`
- Evidence: 用例通过；捕获的 spawn 参数不含 `--session`，含历史文本

### Notes
- Pi CLI 相关 flag：`--append-system-prompt`、`--skill`、`--session-dir`

---

## Issue: I5 — agent 间派发与去重
Type: AFK
Blocked by: I3
User stories covered: Story 3

### What to build
agent 消息可触发其他 agent（auto 模式）。识别两条路径：结构化 `handoff_to`
工具（主）与 `@name` 文本（次），**按目标去重**。

### Acceptance criteria
- [ ] `handoff_to` 派发触发目标 agent
- [ ] agent 消息中 `@name` 也触发目标
- [ ] 同一消息中两条路径指向同一目标 → 只入队一次
- [ ] 两条路径指向不同目标 → 都生效
- [ ] 受既有护栏约束（fanout ≤ 20、depth ≤ 100、budget ≤ 20、revisit ≤ 5）

### Validation
- Command: `pnpm test`（`dispatch.test.ts`）
- Evidence: 用例通过

### Notes
- 修订 Q14：`handoff-intent.ts` 现有注释称「a mention in emitted text is
  deliberately ignored」，需按 Q34 改为次路径并去重

---

## Issue: I6 — 流程守卫（循环 / 轮次 / 终止）
Type: AFK
Blocked by: I5
User stories covered: Story 4、5、6、7

### What to build
三个守卫，状态全部落 SQLite：
- 循环检测：链中重复 agent → 阻断 + 系统消息
- 轮次上限：默认 5，超限向 Coordinator 注入强制收尾
- 终止信号：Coordinator 输出 `[讨论结束]` → terminated，阻断后续触发

### Acceptance criteria
- [ ] A→B→A 第二次对 A 的触发被阻断，流中显示系统消息
- [ ] 用户新消息重置链，A 可再次触发
- [ ] 合法链路（用户→A→B→Coordinator）不误判
- [ ] 达上限→ Coordinator 强制收尾；超限后不再处理新触发
- [ ] 用户新消息重置轮次
- [ ] `max_rounds` 可按 room 配置
- [ ] Coordinator 的 `[讨论结束]` → terminated；非 Coordinator 忽略 + warn
- [ ] terminated 下用户新消息 → 重置
- [ ] **terminated / round_count / chain 进程重启后仍保持**
- [ ] 单测覆盖上述每条

### Validation
- Command: `pnpm test`（`guards.test.ts`）+ 重启进程验证持久化
- Evidence: 用例通过；重启脚本输出显示状态保持

### Notes
- 上游用内存 Map 且接受重启即丢；我们**不继承**此缺陷（Q28/Q29）
- 终止责任在平台不在 LLM；守卫必须在代码层

---

## Issue: I7 — /api/pi 群聊投影
Type: AFK
Blocked by: I6
User stories covered: Story 2（AC2.2）、Story 9

### What to build
一个 ChatRoom == 一个 PiClient thread。共享消息流投影为 thread 消息序列，
每条消息带作者（user / 某 agent）。扩展 `pi-thread.ts` / `pi-routes.ts`。

### Acceptance criteria
- [ ] `GET /api/pi/threads` 列出 ChatRoom
- [ ] thread 快照的消息序列按 seq 有序，含作者标识
- [ ] agent 回复出现在共享流中
- [ ] SSE 推送带作者的消息事件
- [ ] 单测：投影正确性、事件翻译

### Validation
- Command: `pnpm test`（扩展 `pi-thread.test.ts`）
- Evidence: 用例通过

### Notes
- 保持现有 Task==Thread 投影不破坏（旧路径仍工作）

---

## Issue: I8 — UI 三栏布局 + @输入 + 成员面板
Type: HITL（视觉需人工确认）
Blocked by: I7
User stories covered: Story 9

### What to build
三栏：会话列表 / 群聊区（多 agent 头像 + `@` 输入）/ 成员面板。
对齐 teamagentx 视觉。

### Acceptance criteria
- [ ] 三栏布局
- [ ] 每条消息显示作者头像与名字，不同 agent 可区分
- [ ] 输入框 `@` 唤起成员选择
- [ ] 成员面板展示群内 agent 及角色
- [ ] 可导入团队包（入口）

### Validation
- Command: `pnpm --filter @my-team-agents/web build` + 浏览器冒烟
- Evidence: 构建通过；截图显示三栏与多 agent 消息

### Notes
- 上游 MIT（Copyright 2026 dbfu），搬运代码需保留署名
- 继续用 `usePiRuntime`（Q27）

---

## Issue: I9 — 技能管理 UI
Type: AFK
Blocked by: I8
User stories covered: Story 8

### What to build
查看 / 安装 / 卸载 agent 技能。技能随 agentDir 落地，执行时 `--skill` 注入。

### Acceptance criteria
- [ ] 可查看每个 agent 的技能列表
- [ ] 技能随 agentDir 落地，执行时通过 `--skill` 注入
- [ ] 可安装 / 卸载

### Validation
- Command: `pnpm test` + 构建
- Evidence: 用例通过；UI 可操作

---

## Issue: I10 — 真实端到端验证
Type: HITL
Blocked by: I1–I9
User stories covered: 全部

### What to build
在**真实模型**下跑通 PRD §6 全部六项。

### Acceptance criteria
- [ ] 导入 `全栈软件研发` 包 → 5 agent 的 ChatRoom
- [ ] @架构师 → 以自身身份回复，明显使用群上下文
- [ ] agent 间发生一次自动交接
- [ ] 人为 A→B→A → 循环被阻断
- [ ] 达轮次上限 → Coordinator 强制收尾
- [ ] 杀 Worker 重启 → 未完成 Task 继续执行，无重复计费
- [ ] `just check` 全绿

### Validation
- Command: `just check`、`just pi-smoke`、真实模型端到端脚本
- Evidence: 命令退出码 0；脚本输出逐项 PASS

### Notes
- 真实模型配置已存在：`~/.pi/agent/models.json`（provider `airouter`）

---

## Granularity

```text
Granularity: Right-sized
Reason: 每条 issue 证明一个用户可见或契约可见行为，有单一验证接缝与证据类型，
        可独立合并。I1 是数据层但它本身即交付物（ChatRoom 实体 + 表）。
Adjustments: I3/I4 可合并，但分开能独立验证「触发正确」与「上下文正确」，
             故保留拆分。
```
