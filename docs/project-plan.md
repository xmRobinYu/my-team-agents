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

已验证：`rm -rf packages/*/dist && just check` 退出码 0（含 `verify-docs` 映射检查）；
`pnpm test` / `just test-no-build` 在无构建产物下退出码 0；
react-pi 端到端经真实 HTTP client 走通（创建空 thread → 发送激活 → SSE → idle，
底层 Task `succeeded`）；`just pi-smoke` 对真实 Pi 验证 agent_settled 与会话续跑；
`check_rendered_harness.py` 判定 conform。

> 飞书网络同步依赖本机 lark-cli Keychain。沙箱/自动化环境读不到系统 Keychain 时，
> `just sync-docs` 会失败（`verify-docs` 离线映射仍通过），需在有权限的交互终端执行。

## 里程碑

### M1 — 可信闭环（已完成）

目标：把“任务 → 执行 → 声明交接 → 成本报告”跑成可验证的骨架。

- ✅ 结构化交接（`handoff_to`），拒绝散文解析；
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
| 本机模式无鉴权 | 不能暴露到共享/团队环境 | P7b 发布门槛：鉴权 + 租户隔离 + 审计 |
| react-pi `agentDir` 全局单例 | 多租户隔离受阻 | UI 经 `/api/pi` 投影连服务端，不直连 supervisor；租户隔离在服务端处理 |
| 文档与实现漂移（参考项目已出现） | 规划失真 | 仓库为唯一事实来源，文档由脚本单向覆盖同步飞书 |

## 协作约定

- 任何产品/架构/计划变更，先改仓库文件，再执行 `just sync-docs` 同步飞书。
- 决策以 `CONTEXT.md` 决策记录（append-only）为准，不覆盖历史条目。
- 门禁命令以 `AGENTS.md` Verification Matrix 为准；不新增无法通过的门禁。
