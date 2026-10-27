import { useMemo, useState } from "react";
import type { Catalog, CreateTaskBody } from "../api/types";

export interface Draft {
  tenantId: string;
  projectId: string;
  memberId: string;
  workspacePath: string;
  prompt: string;
}

const defaultDraft = (catalog: Catalog): Draft => {
  const project = catalog.projects[0];
  const member =
    catalog.members.find((item) => item.projectId === project?.id) ?? catalog.members[0];
  return {
    tenantId: catalog.tenants[0]?.id ?? "default",
    projectId: project?.id ?? "default",
    memberId: member?.id ?? "mock-agent",
    workspacePath: project?.workspacePath ?? "",
    prompt: "",
  };
};

/**
 * 新任务提交面板。
 *
 * - 项目/成员来自 GET /api/catalog（不可用时回退内置 default / mock-agent）；
 * - body 严格为 {tenantId, projectId, memberId, workspacePath, prompt, idempotencyKey}；
 * - 防双击：提交中按钮禁用；同一草稿复用 idempotencyKey（useTaskSubmit 内 inflight 复联）。
 */
export function NewTaskPanel({
  catalog,
  submitting,
  error,
  fromApi,
  onSubmit,
}: {
  catalog: Catalog;
  submitting: boolean;
  error: string | null;
  fromApi: boolean;
  onSubmit: (body: Omit<CreateTaskBody, "idempotencyKey">) => Promise<unknown>;
}) {
  const [override, setOverride] = useState<Partial<Draft> | null>(null);
  const defaults = useMemo(() => defaultDraft(catalog), [catalog]);
  const draft: Draft = { ...defaults, ...override };

  const membersForProject = catalog.members.filter(
    (member) => member.projectId === draft.projectId,
  );
  const project = catalog.projects.find((item) => item.id === draft.projectId);

  const patch = (next: Partial<Draft>) => setOverride({ ...override, ...next });

  const changeProject = (projectId: string) => {
    const nextProject = catalog.projects.find((item) => item.id === projectId);
    const nextMember = catalog.members.find((member) => member.projectId === projectId);
    patch({
      projectId,
      ...(nextMember ? { memberId: nextMember.id } : {}),
      ...(nextProject?.workspacePath ? { workspacePath: nextProject.workspacePath } : {}),
    });
  };

  const promptEmpty = draft.prompt.trim().length === 0;
  const pathEmpty = draft.workspacePath.trim().length === 0;
  const disabled = submitting || promptEmpty || pathEmpty;

  return (
    <section className="card new-task-card" aria-label="新任务">
      <header className="card-head">
        <div>
          <h2>新任务</h2>
          <p className="card-sub">POST /api/tasks · 提交后进入队列</p>
        </div>
      </header>

      <form
        className="card-body form"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          void onSubmit({
            tenantId: draft.tenantId,
            projectId: draft.projectId,
            memberId: draft.memberId,
            workspacePath: draft.workspacePath.trim(),
            prompt: draft.prompt.trim(),
          });
        }}
      >
        <div className="form-grid">
          <label className="form-field">
            <span>租户</span>
            <select
              value={draft.tenantId}
              onChange={(event) => patch({ tenantId: event.target.value })}
              disabled={submitting || catalog.tenants.length <= 1}
            >
              {catalog.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}（{tenant.id}）
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>项目</span>
            <select
              value={draft.projectId}
              onChange={(event) => changeProject(event.target.value)}
              disabled={submitting}
            >
              {catalog.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.id}）
                </option>
              ))}
            </select>
          </label>

          <label className="form-field">
            <span>成员</span>
            <select
              value={draft.memberId}
              onChange={(event) => patch({ memberId: event.target.value })}
              disabled={submitting || membersForProject.length === 0}
            >
              {membersForProject.length === 0 ? (
                <option value={draft.memberId}>{draft.memberId}</option>
              ) : (
                membersForProject.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}（{member.id} · {member.runtime}）
                  </option>
                ))
              )}
            </select>
          </label>
        </div>

        <label className="form-field">
          <span>
            工作目录 <em className="req">必填</em>
          </span>
          <input
            type="text"
            value={draft.workspacePath}
            spellCheck={false}
            placeholder="/absolute/path/to/workspace"
            onChange={(event) => patch({ workspacePath: event.target.value })}
            disabled={submitting}
            aria-invalid={pathEmpty}
          />
          {pathEmpty ? (
            <small className="hint-warn">
              目录接口未提供 workspacePath，请填目标项目的绝对路径（后端要求非空）。
            </small>
          ) : (
            <small className="hint">
              {project ? `${project.name} 的默认目录` : "后端以该路径作为执行工作区"}
            </small>
          )}
        </label>

        <label className="form-field">
          <span>
            任务提示词 <em className="req">必填</em>
          </span>
          <textarea
            value={draft.prompt}
            rows={5}
            placeholder="描述目标、约束与验收标准；执行体会在结束时给出结构化结果。"
            onChange={(event) => patch({ prompt: event.target.value })}
            disabled={submitting}
            aria-invalid={promptEmpty}
          />
        </label>

        {error ? (
          <p className="inline-error" role="alert">
            提交失败：{error}
          </p>
        ) : null}
        {!fromApi ? (
          <p className="inline-note">
            /api/catalog 不可用，已使用内置默认目录（default / default 项目 / mock-agent）。
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={disabled}>
            {submitting ? "提交中…" : "提交任务"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={submitting}
            onClick={() => setOverride({ ...defaults, prompt: "" })}
          >
            重置
          </button>
        </div>
        <p className="foot-note">
          请求进行中按钮禁用；同一草稿复用同一 idempotencyKey，双击不会产生第二个任务。
        </p>
      </form>
    </section>
  );
}
