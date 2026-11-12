# my-team-agents 项目计划

> 本文档与仓库同步；仓库为唯一事实来源。
> 源文件：`docs/project-plan.md`。状态以实际提交与门禁结果为准，不写预期当既成。

## 当前状态

分支 `main`，已推送至 `git@github.com:xmRobinYu/my-team-agents.git`。

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 治理底座 | 仓库初始化、严格类型、命名与规则守卫、CI 聚合门禁 | ✅ 完成 |
| P1 运行时契约 | `runtime-core` 事件契约 + Pi/CLI 适配器 | ✅ 完成 |
| P2 领域骨架 | Tenant / Project / Group / Member / Task / Handoff + 护栏 | ✅ 完成 |
| P3 成本报告 | 会话日志解析、按租户/项目/成员归因、幂等游标 | ✅ 完成 |
| P4 链路中枢 | dispatcher + 声明式交接 + 停滞看门狗 | ✅ 完成 |
| P5 文档与知识库 | 产品/架构/计划文档 + 飞书知识库同步机制 | ✅ 完成 |
| P6 队列持久化 | 崩溃不丢任务、重试、租约 | ✅ 完成 |
| P7a 服务端 + UI（本机） | API 骨架、SSE、assistant-ui（react-pi）接入 | ✅ 完成 |
| P7b 团队服务化 | 鉴权、租户隔离、审计 | ⬜ 待启 |
| P8 多 agent 群聊 | ChatRoom、团队模板导入、auto 接力与流程守卫 | 🚧 进行中（I1–I10 已做完，剩建群入口未接 UI） |
| P9 事件入口与触发路由 | 外部信号→声明式规则→Task；出站通知、预算熔断、并发、对端联调、执行隔离 | ✅ 完成（P9a/P9b/P9c/P9d/P9e 已做完；出网白名单与 AC7.11 另计，见 PRD §7） |

**P8 分项进度**（I1–I10 定义见 `docs/prd/multi-agent-group-chat-issues.md`）：

- ✅ 完成 I1 ChatRoom 领域模型与持久化（`2efdd93`）
- ✅ 完成 I2 团队模板包解析与导入（`0f00560`；真实包 `全栈软件研发` 5 个 agent 导入通过）
- ✅ 完成 飞书多维表格进度投影（`7d0b501`）
- ✅ 完成 I3 @提及触发与人格执行（`328dc6c`）
- ✅ 完成 I4 群历史注入（`bc0f514`）
- ✅ 完成 I5 agent 间派发与去重（`durable-worker.ts` + `handoff-intent.ts`，Q41）
- ✅ 完成 I6 流程守卫：循环 / 轮次上限 / 终止（`2c14dde`）
- ✅ 完成 I7 `/api/pi` 群聊投影（`pi-room-thread.ts` + `pi-room-routes.ts`，Q42）
- ✅ 完成 I8 UI 三栏布局（`packages/web/src/rooms` + `components/rooms`，Q42）
- ✅ 完成 I9 技能加载与服务面（`--skill` 注入 + `/api/rooms/:id/agents/:agentId/skills`，Q43；
  独立的技能管理页面仍未做，见 `docs/architecture.md` §9）
- ✅ 完成 I10 真实端到端验证（`scripts/prd-acceptance.mjs`，六项 PASS，Q44）

已验证（2026-11-12）：`rm -rf packages/*/dist && just check` 退出码 0（`just check` =
build → typecheck → test → verify-cli → test-guardrails → verify-docs → verify-bitable →
test-scripts → verify-packages → **verify-file-size**，以 `justfile` 定义为准）；
`just test-no-build` 在无构建产物下退出码 0，**564 passed / 5 skipped**；
react-pi 端到端经真实 HTTP client 走通（创建空 thread → 发送激活 → SSE → idle，底层 Task
`succeeded`），群 thread 用真实 `createPiHttpClient` + 真实 reducer 验证；
`just pi-smoke` 对真实 Pi 验证 agent_settled 与会话续跑；
`node scripts/prd-acceptance.mjs` 在真实模型下跑通 PRD §6 六项（手动门禁，不入 CI）；
**`just p9-smoke`：已有 27 项全绿**（真 HTTP server + 真 worker OS 进程 + 真 webhook 接收端 +
上游 `ref/AIHOT` 自己的 `wakeAgent`），**新增 `iso` 项 15 项全绿、exit 0**（2026-11-12 实测，
含容器内一次真实模型写文件并落盘到宿主）；手动门禁，不入 CI。

**P9 分项进度**（定义见 `docs/prd/event-ingress.md` §10）：

- ✅ 完成 P9a 事件入口内核（`inbound_events` + `trigger_rules` + `lane` 串行 + 四种结局，Q49）
- ✅ 完成 P9.5 定时即事件（`cron` 是规则上的数据；`just verify-import` 有 AC4.3 证据段）
- ✅ 完成 P8 补丁另一半：迁移账本 `schema_migrations` + `applyMigrations`
- ✅ 完成 P9b `tell` 出站 + 决策账本 + 冷却 + 单一通道（Q50）
- ✅ 完成 P9b `skill` 贯通：登记校验 + 派发解析 `agentDir` → `--skill` 真的到达事件 run
- ✅ 完成 P9c `error_kind` 闭集 + Task 级预算熔断（超限进 `blocked`）
- ✅ 完成 P9c `parallel>1`（改 `claimNext` 谓词为按 `parallel` 计数；`groupId` 一律钳 1）
- ✅ 完成 P9c 入站鉴权收紧（开了就必须有可用令牌；短令牌不降级成匿名）
- ✅ 完成 P9c redrive 双 worker 竞态修复（`claimRetry` 条件 UPDATE）
- ✅ 完成 P9e 真实对端联调（跑上游 `wakeAgent`；抓到「body 没有 `source`」与
  「hub key 就是本平台 token」两个单测抓不到的缺口）
- ✅ 完成 治理补齐：`size_limits.max_file_lines` 从此**真的被检查**（棘轮 baseline），
  并把 `template-import.ts`(1166→425) 与 `durable-worker.ts`(959→879) 拆到限额内
  （P9d 的门禁本想加进后者，棘轮拒绝它变长，于是 `personaThinking` 被抽成独立模块）
- ✅ 完成 **P9d 执行隔离**（`just p9-smoke` 的 `iso` 项：15 项全绿、exit 0）：
  `docker run` 包同一份 `pi` argv；登记与执行两道门；容器内真实模型写文件并落盘宿主。
  provider 的配额是共享的 token/分钟，窗口约 20 分钟一次，脚本因此先等窗口再请求
  （`MTA_P9_WINDOW_MS`，等不到仍 `BLOCKED` / exit 2）
- ⬜ 多级升级链与决策账本 UI 未做（P9b 只到 `blocked`/`failed` 两级）

> 飞书网络同步依赖本机 lark-cli Keychain。沙箱/自动化环境读不到系统 Keychain 时，
> `just sync-docs` 会失败（`verify-docs` 离线映射仍通过），需在有权限的交互终端执行。

## 里程碑

### M1 — 可信闭环（已完成）

目标：把“任务 → 执行 → 声明交接 → 成本报告”跑成可验证的骨架。

- ✅ 结构化交接（`handoff_to`），拒绝散文解析（当时的 Q14 口径；此限制已由 Q34 修订，
  见下方 M3.5 的次路径与去重）；
- ✅ 确定性护栏（fanout / depth / budget / revisit）；
- ✅ 运行时缺失时降级为 `failed`，不穿透调用方；
- ✅ 停滞看门狗避免卡死 run 占位；
- ✅ 每日自评估报告可幂等增量运行；
- ✅ 端到端冒烟：`pi` 1.4.0 已安装，`just pi-smoke` 对真实模型验证通过。

### M2 — 耐久（已完成）

目标：让排队工作不因进程重启丢失。

- ✅ SQLite 持久化 Task/Attempt/Event/Usage/交接 outbox；
- ✅ 租约 + fencing token，旧 Attempt 迟到写入被拒绝；
- ✅ 每批次最多 3 次自动尝试、退避重试、人工重试保留历史；
- ✅ 确定性恢复快照；runtime 支持时恢复原 Pi 会话（Q18）；
- ✅ 验收：杀掉进程重启后未完成任务继续执行，且不重复计费。

### M3 — 可服务（本机已完成，团队化待启）

- ✅ Fastify API + SSE；API 与 Worker 独立进程；
- ✅ assistant-ui 集成：`@assistant-ui/react-pi` 的 `usePiRuntime`，经 `/api/pi`
  投影层连服务端（不直连 Pi 进程，服务端保持权威）；
- ⬜ 团队化（P7b）：鉴权、租户隔离、审计、按租户 `agentDir` 隔离。

### M3.5 — 多 agent 群聊

目标：从「单 agent 会话」升级为「团队群聊」，复用 teamagentx 的模板生态。

- ✅ ChatRoom 实体：共享消息流 + 成员 + 规则，与 Group（视图）分离（I1，`2efdd93`）；
- ✅ 团队模板导入：解析 teamagentx 包（room + agents + skills），一键成群（I2，`0f00560`）；
- ✅ 人格隔离：每个 agent 独立 agentDir（cwd + skills + AGENTS.md）（I2，`template-import.ts`）；
- ✅ auto 接力：`handoff_to` 优先 + `@` 文本次路径，按目标去重，去重在流程守卫**之前**
  （I3/I5，`dedupeByOrigin`；见 `CONTEXT.md` Q41）；
- ✅ 流程守卫：循环检测、轮次上限（默认 5）、`[讨论结束]` 终止，状态持久化（I6，`2c14dde`）；
- ✅ UI：三栏布局 + 多 agent 头像 + `@` 输入 + 成员面板；群投影为 Pi thread（I7/I8，Q42）；
  技能的注入与服务面同批完成（I9，Q43）；
- ⬜ 技能管理页面：清单/安装/卸载 API 与 `--skill` 注入已完成并有门禁；
  `packages/web` 里独立的技能管理页面未做（I9 剩余部分，见 `docs/architecture.md` §9）；
- ✅ 验收：PRD §6 六项在**当前代码**上由 `scripts/prd-acceptance.mjs` 真实模型跑通
  （退出码 0，209.4s；导入 `全栈软件研发`、@提及带身份回复并使用群上下文、
  `handoff_to` 主路径自动交接 —— 真实 `toolCallId`、花名册带 id 不翻磁盘、
  子 Task 走完整群注入、名字形式也被解析，A→B→A 阻断、达上限强制收尾、
  杀 Worker 重启不重复计费）。**保留的局限**：
  ① AC5.2 的超限阻断**已在真实模型下直接观察到**（第 5 项独立探针，目标 Task 数 0）；
  能观察到需同时满足"群未被终止"（`coordinator_agent_id` 置空）与"目标在链外"，
  否则按判定顺序 `terminated → LOOP → ROUND_CAP` 会先撞别的分支（Q44）；
  ② 第 5 项"协调者输出 `[讨论结束]`"在真实模型下**实测不稳定** ——
  同一份代码首跑 FAIL（收尾 Task 三次 Attempt 全失败、未终止），重跑与定稿跑 PASS；
  六项 PASS 是 r8 这一次的事实，不能据此宣称该项稳定。
  该门禁需 pi + provider + 网络，手动执行。

PRD：`docs/prd/multi-agent-group-chat.md`；决策：`CONTEXT.md` Q28–Q44。

### M4 — 职能型数字员工

- 把 `Member` 与“数字员工控制面”拆开：身份、归属、职责、生命周期独立建模；
- 工作范围与访问范围分离，不再让 `projectId: null` 承担所有跨项目语义；
- 知识与技能版本化引用，一次运行可追溯当时配置。

### M5 — 分身型数字员工

前置：委托授权、审计、分层记忆三项必须成立。

- 明确 `actor` / `subject` / 委托记录 / 业务目的；
- 个人记忆的写入授权与可撤销；
- 代理对外沟通默认需人工确认，先做“只起草、不发送”。

## 延后清单（明确不做，保留接口）

| 项 | 原因 | 保留方式 |
|---|---|---|
| 技能市场 / 工具市场 | 服务端与鉴权尚未存在，先做 CRUD 价值低 | 先做注册与版本，UI 后置 |
| 晋升体系 / 能力包仓库 | 用户决定“往后放一放” | `Member.grade` 接口留白 |
| 完整五层成本账本 | 用户改为“每日自评估” | 归因三键已贯穿 |
| 自动根据反馈改配置 | 一次错误反馈即可永久改变行为，风险不对称 | 反馈→建议→人工评审 |
| 数字员工“销毁”即删记录 | 需处理在途任务、凭证、审计留存 | 生命周期设计阶段处理 |

## 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| codex 结构化输出未确认 | 事件归一化降级为纯文本 | 记为已知缺口，确认后升级解析 |
| 队列已持久化 | — | M2 已完成：SQLite + 租约 + fencing token |
| 本机模式无鉴权 | 不能暴露到共享/团队环境 | P7b 发布门槛：鉴权 + 租户隔离 + 审计；persona 会话写入已收窄到 `<agentDir>/.pi/sessions`（Q44/D3），但这是"放近"不是沙箱，完整隔离仍属 P7b |
| react-pi `agentDir` 全局单例 | 多租户隔离受阻 | UI 经 `/api/pi` 投影连服务端，不直连 supervisor；租户隔离在服务端处理。另：`handoff_to` 依赖本仓库自带的 Pi 扩展（显式 `--extension`），扩展文件缺失是**硬错误**而非静默跳过（Q44/D1） |
| 文档与实现漂移（参考项目已出现） | 规划失真 | 仓库为唯一事实来源，文档由脚本单向覆盖同步飞书 |

## 协作约定

- 任何产品/架构/计划变更，先改仓库文件，再执行 `just sync-docs` 同步飞书。
- 决策以 `CONTEXT.md` 决策记录（append-only）为准，不覆盖历史条目。
- 门禁命令以 `AGENTS.md` Verification Matrix 为准；不新增无法通过的门禁。
