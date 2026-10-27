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
- **dsh**：实测是 cordis 插件/profile 启动器（`~/.dsh/profiles/<name>/cordis.patch.yml`），
  不是编码 Agent 运行时；仅作为 CLI 适配器接入。
- **claude**：`--output-format stream-json`、`--input-format stream-json`、
  `--max-budget-usd`、`--permission-mode`。
- **codex**：`--sandbox`、`-a/--ask-for-approval`、`--full-auto`、`-C/--cd`；其稳定的
  结构化 JSON 事件输出**尚未确认**，因此当前按纯文本降级归一化（已知缺口，见 §7）。

## 4. 协作域模型

```ts
Tenant                      // 租户
Project  { workspacePath, agentDir? }   // 拥有工作区；agentDir 为扩展接口
Group    { projectId }                  // 群聊只是项目上的视图
Member   { kind, projectId | null, runtime, grade? }
Task     { tenantId, projectId, memberId, prompt, status }
Handoff  { fromTaskId, toMemberIds, reason, depth }
```

已确立语义（`CONTEXT.md` 决策记录 Q2/Q14/Q15）：

- 执行型 Agent 绑定**恰好一个**项目（其技能与记忆位于该项目工作区）。
- 汇报类角色（PMO / 群管理员 / HR）可跨项目 → `projectId: null`。
- 交接是**声明式**的（`handoff_to` 工具调用），绝不从散文/正则解析。
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
revisit ≤ 5，审计开启。

`StallWatchdog` 用注入式时钟与 `unref()` 定时器实现，`ping()` 由事件流驱动，超时触发
`onStall` → 取消该 run，避免卡死的 run 长期占用队列槽位。

## 6. 成本与自评估

`cost-report` 从 Pi 会话 JSONL 解析消息级 usage，按
`tenant / project / member / model` 聚合并输出表格或 JSON。`--since-file` 写回
entry-id 游标，使**每日重复运行幂等**（已实测：第二次运行新增 0 token）。

## 7. 扩展接口（刻意留白，不生效）

| 接口 | 位置 | 未来填充 |
|---|---|---|
| 按 run 的 `agentDir` | `RunSpec.agentDir`、`Project.agentDir` | 多租户隔离；react-pi 的 `agentDir` 目前只能在 supervisor 构造时固定（已核实），需补丁 + 上游 PR |
| 职级 | `Member.grade` | 晋升体系 / HR 评审 |
| 队列持久化 | 当前为进程内 FIFO | 崩溃丢失排队任务，为已知 V1 限制（Q16） |
| 鉴权与委托 | 尚未建模 | 职能型 / 分身型的前置条件 |
| 技能/工具市场 | 尚未建模 | 先做注册与版本，再做市场 |

## 8. 治理机制

- `just check` = build → typecheck → test → verify-cli → test-guardrails →
  verify-docs。**顺序有语义**：
  包之间通过 `dist/*.d.ts` 互相消费，未 build 的干净检出会 `TS2307`。
  测试另经 `vitest.config.ts` 别名解析到 `src/`，因此 `pnpm test` 单独可跑（已实测）。
- 命名与规则守卫：`.git-hooks/check-naming.sh` 拒绝 `.bak`/`_v2`/`tmp/` 等产物名，并要求
  规则文件（`AGENTS.md`、`CONTEXT.md`、`constraints.yaml`、`justfile`、`vitest.config.ts`、
  `tsconfig.base.json`、`.git-hooks/*`）变更必须携带 `RULE_CHANGE_REASON`。
- 文档同步：`just sync-docs` 把 `docs/`、`AGENTS.md`、`CONTEXT.md` 覆盖同步到飞书
  `my-team-agents` 知识库（空间 ID `7701231058624187646`）。

## 9. 已知缺口（不掩盖）

1. `pi` 全局二进制未安装 → Pi 适配器无法端到端冒烟（会以 `failed` 优雅报错）。
2. codex 稳定结构化事件输出未确认 → 归一化按纯文本降级。
3. 无 eslint → 刻意不提供 `just lint`，避免幻影门禁。
4. 队列不持久 → 进程重启丢任务。
5. 服务端与 assistant-ui 未接入 → V1 无 UI。
