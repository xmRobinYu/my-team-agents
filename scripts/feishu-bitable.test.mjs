import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSnapshot,
  planTable,
  phaseStatus,
  itemStatus,
  rowsFor,
  schemaProblems,
  coerce,
  formatLocalMinute,
  validateConfig,
  cellText,
  massRemovalProblem,
} from "./feishu-bitable.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* ------------------------------------------------------------------- fixtures */

const PLAN = `# t

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 治理底座 | 初始化 | ✅ 完成 |
| P7b 团队服务化 | 鉴权 | ⬜ 待启 |

已验证：\`just check\` 退出码 0。

## 里程碑

### M1 — 可信闭环（已完成）

目标：跑通骨架。

- ✅ 交接；
- ✅ 护栏。

### M2 — 群聊

- ⬜ ChatRoom；
  续行说明。
- 验收：真实模型跑通。

## 延后清单（明确不做，保留接口）

| 项 | 原因 | 保留方式 |
|---|---|---|
| 晋升体系 | 用户决定 | 接口留白 |

## 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| codex 未确认 | 降级 | 记为缺口 |
`;

const CTX = `# c

## Decision Log

### Q1 — Strictness
**A**: L3.

### Q2/Q3 — Runtimes
**A**: three adapters.

## Reference Notes
`;

const snap = buildSnapshot(PLAN, CTX);

const table = (key, name = key, extra = {}) => {
  const fields = {
    phases: ["阶段号", "阶段名称", "范围", "状态", "状态原文", "文档顺序", "仓库内"],
    milestones: ["里程碑号", "标题", "目标", "状态", "条目总数", "已完成条目", "完成度", "参考", "仓库内"],
    items: ["条目主键", "里程碑号", "条目序号", "内容", "状态", "仓库内"],
    risks: ["风险", "影响", "应对", "文档顺序", "仓库内"],
    deferred: ["项", "原因", "保留方式", "文档顺序", "仓库内"],
    overview: ["总览", "快照"],
    changelog: ["快照", "同步时间", "摘要"],
  }[key];
  const spec = JSON.parse(read("docs/feishu-bitable.json")).tables.find((t) => t.key === key);
  return {
    key,
    name,
    primaryKey: spec.primaryKey,
    fields: spec.fields.filter((f) => fields.includes(f.name)),
    ...extra,
  };
};

/* -------------------------------------------------------------------- parsers */

test("phases: code is split from name, status maps to fixed options", () => {
  assert.deepEqual(
    snap.phases.map((p) => [p.key, p.name, p.status]),
    [
      ["P0", "治理底座", "完成"],
      ["P7b", "团队服务化", "待启"],
    ],
  );
  assert.equal(snap.phases[0].statusRaw, "✅ 完成");
});

test("phaseStatus never invents completion", () => {
  assert.equal(phaseStatus("✅ 完成"), "完成");
  assert.equal(phaseStatus("⬜ 待启"), "待启");
  assert.equal(phaseStatus("⬜ 下一步（PRD 已定稿）"), "下一步");
  assert.equal(phaseStatus("🟡 进行中"), "进行中");
  assert.equal(phaseStatus("完成 80%？"), "完成"); // documented as done, kept honest by 状态原文
  assert.equal(phaseStatus(""), "未标注");
  assert.equal(phaseStatus("待启"), "待启");
  assert.equal(phaseStatus("已完成，待验收"), "未标注");
});

test("milestones: goal, bullets and unwrapped continuations", () => {
  const m1 = snap.milestones.find((m) => m.key === "M1");
  assert.equal(m1.title, "可信闭环（已完成）");
  assert.equal(m1.status, "已完成");
  assert.equal(m1.total, 2);
  assert.equal(m1.done, 2);

  const m2 = snap.milestones.find((m) => m.key === "M2");
  assert.equal(m2.status, "待办");
  assert.equal(m2.total, 2);
  // The indented continuation must fold into the previous item, not vanish.
  assert.match(snap.items.find((i) => i.key === "M2#1").text, /^ChatRoom； 续行说明。$/);
});

test("itemStatus maps markers and degrades silently-stated items to 未标注", () => {
  assert.equal(itemStatus("✅ 交接；"), "已完成");
  assert.equal(itemStatus("⬜ ChatRoom；"), "待办");
  assert.equal(itemStatus("验收：真实模型跑通。"), "未标注");
});

test("risks and deferred parse from their tables, heading suffix tolerated", () => {
  assert.deepEqual(
    snap.risks.map((r) => [r.key, r.impact, r.mitigation]),
    [["codex 未确认", "降级", "记为缺口"]],
  );
  assert.deepEqual(
    snap.deferred.map((d) => [d.key, d.reason, d.seam]),
    [["晋升体系", "用户决定", "接口留白"]],
  );
  assert.equal(snap.verifiedNote, "已验证：`just check` 退出码 0。");
});

test("decisions: slash headings count every entry and latest wins", () => {
  assert.equal(snap.decisions.count, 3);
  assert.equal(snap.decisions.highest, 3);
  assert.equal(snap.decisions.latestHeading, "Q2/Q3 — Runtimes");
});

test("snapshotId is stable and changes when state changes", () => {
  assert.equal(buildSnapshot(PLAN, CTX).snapshotId, snap.snapshotId);
  const changed = buildSnapshot(PLAN.replace("⬜ 待启", "✅ 完成"), CTX);
  assert.notEqual(changed.snapshotId, snap.snapshotId);
  // Prose outside the tracked surfaces must not churn the fingerprint.
  assert.equal(buildSnapshot(`${PLAN}\nextra prose\n`, CTX).snapshotId, snap.snapshotId);
});

test("parsers fail loudly when a tracked table disappears or changes shape", () => {
  assert.throws(() => buildSnapshot(PLAN.replace("## 当前状态", "## 现在"), CTX), /当前状态/);
  assert.throws(
    () => buildSnapshot(PLAN.replace("| 阶段 | 内容 | 状态 |", "| 阶段 | 内容 | 状态 | 负责人 |"), CTX),
    /header changed/,
  );
});

/* ------------------------------------------------------------------- encoding */

test("coerce encodes documented CellValue shapes and rejects unknown options", () => {
  assert.deepEqual(coerce({ name: "状态", type: "select", options: [{ name: "完成" }] }, "完成"), ["完成"]);
  assert.equal(coerce({ name: "顺序", type: "number" }, 3), 3);
  assert.equal(coerce({ name: "顺序", type: "number" }, "3"), null);
  assert.equal(coerce({ name: "文本", type: "text" }, "P6"), "P6");
  assert.throws(
    () => coerce({ name: "状态", type: "select", options: [{ name: "完成" }] }, "已上线"),
    /no matching option/,
  );
});

test("formatLocalMinute uses Base's wall clock, not UTC", () => {
  const utc = new Date("2026-10-30T22:19:00Z");
  assert.equal(formatLocalMinute(utc), "2026-10-31 06:19");
});

test("cellText flattens select arrays and object cells", () => {
  assert.equal(cellText(["完成"]), "完成");
  assert.equal(cellText([{ name: "完成" }]), "完成");
  assert.equal(cellText(null), "");
  assert.equal(cellText(8), "8");
});

/* --------------------------------------------------------------- upsert logic */

test("upsert: existing rows update in place, new rows are created, nothing is deleted", () => {
  const t = table("phases");
  const desired = rowsFor("phases", snap);
  const existing = [
    { record_id: "rec1", 阶段号: "P0", 阶段名称: "治理底座", 范围: "初始化", 状态: ["待启"], 状态原文: "⬜ 待启", 文档顺序: 1, 仓库内: ["存在"] },
  ];
  const plan = planTable(t, desired, existing);
  assert.deepEqual(
    plan.update.map((u) => [u.key, u.recordId]),
    [["P0", "rec1"]],
  );
  assert.deepEqual(plan.update[0].patch, { 状态: "完成", 状态原文: "✅ 完成" });
  assert.deepEqual(
    plan.create.map((c) => c.key),
    ["P7b"],
  );
  assert.deepEqual(plan.stale, []);
  assert.equal(plan.create[0].recordId, undefined);
});

test("converged state plans zero writes (idempotent re-run)", () => {
  for (const key of ["phases", "milestones", "items", "risks", "deferred", "overview"]) {
    const t = table(key);
    const desired = rowsFor(key, snap);
    const asRecords = desired.map((r, i) => ({ record_id: `rec${i}`, ...r }));
    const plan = planTable(t, desired, asRecords);
    assert.deepEqual(plan.create, [], `${key} create`);
    assert.deepEqual(plan.update, [], `${key} update`);
    assert.deepEqual(plan.stale, [], `${key} stale`);
  }
});

test("select cells read back as arrays do not look different", () => {
  const t = table("phases");
  const desired = rowsFor("phases", snap);
  const rec = { record_id: "r", ...desired[0], 状态: ["完成"], 仓库内: ["存在"] };
  assert.deepEqual(planTable(t, [desired[0]], [rec]).update, []);
});

test("rows missing from the docs are flagged, not deleted", () => {
  const t = table("phases");
  const desired = rowsFor("phases", snap);
  const existing = [
    { record_id: "r1", ...desired[0] },
    { record_id: "r9", 阶段号: "P9", 阶段名称: "已撤回的阶段", 状态: ["待办"], 仓库内: ["存在"] },
  ];
  const plan = planTable(t, desired, existing);
  assert.deepEqual(plan.stale, [{ key: "P9", recordId: "r9" }]);
  assert.deepEqual(
    plan.update.filter((u) => u.key === "P9"),
    [],
  );
  // A second pass sees the flag already set and stops repeating the write.
  const flagged = [...plan.update.map((u) => ({ record_id: u.recordId, ...u.patch })), { record_id: "r1", ...desired[0] }];
  assert.deepEqual(planTable(t, desired, existing).stale.length, 1);
  const after = [
    { record_id: "r1", ...desired[0] },
    { record_id: "r9", 阶段号: "P9", 仓库内: ["已移除"] },
  ];
  assert.deepEqual(planTable(t, desired, after).stale, []);
  assert.equal(flagged.length, 1);
});

test("appendOnly changelog never rewrites history and dedupes by snapshot", () => {
  const t = table("changelog", "进展记录", { appendOnly: true });
  const row = rowsFor("changelog", { ...snap, syncedAt: "2026-10-31 06:19" })[0];
  assert.deepEqual(planTable(t, [row], []).create.length, 1);
  // Same snapshot, later clock: no update, no new row.
  const later = { ...row, 同步时间: "2026-10-31 07:00", 摘要: "different" };
  const plan = planTable(t, [later], [{ record_id: "log1", ...row }]);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.stale, []);
});

/* ------------------------------------------------------------------ schema */

test("real config passes validation and produces rows matching every declared field", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  assert.deepEqual(validateConfig(config), []);
  const real = buildSnapshot(read("docs/project-plan.md"), read("CONTEXT.md"));
  assert.deepEqual(schemaProblems(config.tables, real), []);
});

test("schema check catches an undeclared cell and a lost field", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  const phases = config.tables.find((t) => t.key === "phases");
  const broken = { ...phases, fields: phases.fields.filter((f) => f.name !== "状态原文") };
  assert.match(schemaProblems([broken], snap).join("\n"), /row cell "状态原文" is not a declared field/);
});

test("schema check catches duplicate primary keys before they collapse rows", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  const risks = config.tables.find((t) => t.key === "risks");
  const dup = buildSnapshot(
    PLAN.replace("| codex 未确认 | 降级 | 记为缺口 |", "| codex 未确认 | 降级 | 记为缺口 |\n| codex 未确认 | 别的 | 别的 |"),
    CTX,
  );
  assert.match(schemaProblems([{ ...risks }], dup).join("\n"), /duplicate primary keys/);
});

test("primaryKey must be the first declared field", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  const phases = config.tables.find((t) => t.key === "phases");
  const reordered = { ...phases, fields: [phases.fields[1], ...phases.fields] };
  assert.match(
    validateConfig({ ...config, tables: [reordered, ...config.tables.filter((t) => t.key !== "phases")] }).join("\n"),
    /must be the FIRST field/,
  );
});

/* ------------------------------------------------------------- real documents */

test("the live docs parse into the documented shape", () => {
  const real = buildSnapshot(read("docs/project-plan.md"), read("CONTEXT.md"));
  assert.equal(real.phases.length, 10);
  assert.deepEqual(
    real.phases.map((p) => p.key),
    ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7a", "P7b", "P8"],
  );
  assert.equal(real.milestones.length, 6);
  assert.deepEqual(
    real.milestones.map((m) => m.key),
    ["M1", "M2", "M3", "M3.5", "M4", "M5"],
  );
  assert.ok(real.items.some((i) => i.key === "M3.5#4"));
  assert.equal(real.risks.length, 5);
  assert.equal(real.deferred.length, 5);
  assert.ok(real.decisions.highest >= 35);
  assert.equal(real.phases.filter((p) => p.status === "未标注").length, 0);
});

/* ------------------------------------------------------------- mass removal */

test("mass removal is refused when a doc section disappears", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  const t = config.tables.find((x) => x.key === "risks");
  // A renamed 风险登记 section parses to zero rows; every existing Base row would
  // then be flagged 已移除 — an authoring accident, not a project decision.
  const renamed = buildSnapshot(PLAN.replace("## 风险登记", "## 风险清单"), CTX);
  assert.equal(renamed.risks.length, 0);
  const existing = [
    { record_id: "r1", 风险: "codex 未确认", 仓库内: ["存在"] },
    { record_id: "r2", 风险: "本机无鉴权", 仓库内: ["存在"] },
    { record_id: "r3", 风险: "文档漂移", 仓库内: ["存在"] },
    { record_id: "r4", 风险: "react-pi 单例", 仓库内: ["存在"] },
  ];
  const plan = planTable(t, rowsFor("risks", renamed), existing);
  assert.equal(plan.stale.length, 4);
  assert.match(massRemovalProblem(t, plan, existing.length), /4\/4 existing row\(s\) would be flagged/);
});

test("ordinary row removals are not mass removal", () => {
  const config = JSON.parse(read("docs/feishu-bitable.json"));
  const t = config.tables.find((x) => x.key === "risks");
  const all = rowsFor("risks", buildSnapshot(read("docs/project-plan.md"), read("CONTEXT.md")));
  assert.equal(all.length, 5);
  const existing = all.map((r, i) => ({ record_id: `r${i}`, ...r }));

  // Two risks retired at once: normal project maintenance.
  const plan = planTable(t, all.slice(0, 3), existing);
  assert.equal(plan.stale.length, 2);
  assert.equal(massRemovalProblem(t, plan, existing.length), null);

  // Four of five: refuse until the operator confirms with --allow-mass-removal.
  const gutted = planTable(t, all.slice(0, 1), existing);
  assert.match(massRemovalProblem(t, gutted, existing.length), /4\/5/);
});
