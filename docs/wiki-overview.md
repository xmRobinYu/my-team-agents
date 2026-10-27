# my-team-agents 知识库总览

本知识库集中管理 my-team-agents 的产品规划、架构设计、项目计划、工程规范与决策记录。

**仓库是唯一事实来源。** 飞书页面是仓库文档的同步副本：先改仓库，再执行
`just sync-docs`。同步为整篇覆盖，不要直接在飞书副本上编辑正文，也不要把评论
当作决策记录。

仓库：`git@github.com:xmRobinYu/my-team-agents.git`

## 目录

| 飞书节点标题 | 源文件 | 内容 |
|---|---|---|
| my-team-agents 知识库总览 | `docs/wiki-overview.md` | 目录与维护约定 |
| my-team-agents 产品规划 | `docs/product-plan.md` | 定位、数字员工类型、模块规划、V1 范围 |
| my-team-agents 架构设计 | `docs/architecture.md` | 包结构、运行时契约、协作模型、调度闭环、扩展接口 |
| my-team-agents 项目计划 | `docs/project-plan.md` | 阶段状态、里程碑、延后清单、风险 |
| AGENTS.md | `AGENTS.md` | 目录地图、工作流、验证矩阵、治理约束 |
| CONTEXT.md | `CONTEXT.md` | append-only 决策日志与参考事实 |

## 同步方式

```bash
just sync-docs              # 全量同步（飞书 user 身份）
just sync-docs docs/product-plan.md   # 只同步指定文档
just verify-docs            # 离线检查映射完整性，不访问网络
```

- 映射文件：`docs/feishu-sync.json`（记录 space_id 与每个节点的
  node_token / document_id；不含密钥）。
- 新增文档：先在 `docs/feishu-sync.json` 登记，再 `just sync-docs`。
- 同步入口会逐篇检查 `lark-cli` 返回的 `ok`/`result`，并回读确认内容已写入。
