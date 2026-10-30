/**
 * Pure parsing layer for the Feishu Bitable sync.
 *
 * Reads the repo's source of truth (docs/project-plan.md + CONTEXT.md) and turns
 * it into row sets keyed by a stable business key. No network, no lark-cli here:
 * keeping this side-effect-free is what lets `--check` and `node --test` run in
 * CI without credentials.
 *
 * Design constraints that shape this file:
 *   - The adapter follows the docs, never the other way round. Anything the docs
 *     express in a new shape must degrade to `未标注` + the raw text preserved,
 *     not to a parse failure.
 *   - Every row carries a stable key so the writer can upsert instead of
 *     delete-and-rebuild (delete would destroy user-added rows and record ids).
 *   - Whitespace is folded before comparison so a line wrap in Markdown is not
 *     read as a content change.
 */

import { createHash } from "node:crypto";

/** Fold all whitespace runs to single spaces; keys compare on this. */
export const normalize = (s) =>
  (s ?? "")
    .replace(/\s+/g, " ")
    .trim();

const stripEmphasis = (s) => normalize(s).replace(/\*\*/g, "");

/** Split `| a | b | c |` into trimmed cells; returns null for non-rows. */
function tableCells(line) {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  const cells = t.slice(1, -1).split("|").map(stripEmphasis);
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null; // separator row
  return cells;
}

/**
 * Lines of a `## ` section, from its heading to the next level-1/2 heading.
 *
 * The heading is matched by prefix because the docs qualify it in prose
 * (`## 延后清单（明确不做，保留接口）`); sub-sections (`###  M1`) belong to the
 * section, so stopping at any heading level would truncate them to nothing.
 */
function sectionLines(md, heading) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => stripEmphasis(l).startsWith(`## ${heading}`));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** Rows of the first table inside a `## ` section, keyed by column index. */
function sectionTable(md, heading, expectHeader) {
  const lines = sectionLines(md, heading);
  if (lines === null) return null;
  const rows = [];
  let header = null;
  for (const line of lines) {
    const cells = tableCells(line);
    if (cells === null) {
      if (header && rows.length === 0) continue;
      continue;
    }
    if (header === null) {
      header = cells;
      if (expectHeader && normalize(header.join("|")) !== normalize(expectHeader.join("|"))) {
        return { header, rows: [], headerMismatch: true };
      }
      continue;
    }
    rows.push(cells);
  }
  return { header: header ?? [], rows, headerMismatch: false };
}

const PHASE_RE = /^(P\d+[a-z]?)\s+(.+)$/;

/** Map a Chinese phase/milestone marker to a fixed select option, preserving honesty. */
export function phaseStatus(raw) {
  const t = normalize(raw);
  if (t.includes("完成") && !t.includes("待")) return "完成";
  if (t.includes("下一步")) return "下一步";
  if (t.includes("待启")) return "待启";
  if (t.includes("进行") || t.includes("开发中")) return "进行中";
  if (t === "") return "未标注";
  return "未标注";
}

export function itemStatus(raw) {
  const t = normalize(raw);
  if (t.startsWith("✅") || t.includes("已完成")) return "已完成";
  if (t.startsWith("⬜") || t.startsWith("☐") || t.includes("待办")) return "待办";
  if (t.startsWith("🟡") || t.includes("进行")) return "进行中";
  return "未标注";
}

/** `## 当前状态` phase table -> rows keyed by phase code (P0, P7a, ...). */
export function parsePhases(md) {
  const table = sectionTable(md, "当前状态", ["阶段", "内容", "状态"]);
  if (table === null) {
    throw new Error('project-plan.md: section "## 当前状态" not found');
  }
  if (table.headerMismatch) {
    throw new Error(
      `project-plan.md: "## 当前状态" table header changed, expected | 阶段 | 内容 | 状态 |, got | ${table.header.join(" | ")} |`,
    );
  }
  return table.rows.map((cells, index) => {
    const [first, content, status] = [cells[0] ?? "", cells[1] ?? "", cells[2] ?? ""];
    const m = PHASE_RE.exec(normalize(first));
    // A code-less row is still a real row: keep it under its own text rather
    // than dropping project state on a formatting surprise.
    return {
      key: m ? m[1] : `P?${index}`,
      name: m ? m[2] : normalize(first),
      content: normalize(content),
      status: phaseStatus(status),
      statusRaw: normalize(status),
      order: index + 1,
    };
  });
}

const MILESTONE_RE = /^###\s+(M\d+(?:\.\d+)?)\s*[—–-]\s*(.+)$/;

function milestoneStatus(title, items) {
  const t = normalize(title);
  if (t.includes("待启") || t.includes("下一步")) return "进行中";
  if (t.includes("已完成") || t.includes("已交付")) return "已完成";
  if (items.some((i) => i.status === "已完成") && items.some((i) => i.status !== "已完成")) {
    return "进行中";
  }
  if (items.length > 0 && items.every((i) => i.status === "已完成")) return "已完成";
  return "待办";
}

/** `## 里程碑` -> milestone rows plus their item rows. */
export function parseMilestones(md) {
  const lines = sectionLines(md, "里程碑");
  if (lines === null) return { milestones: [], items: [] };

  const milestones = [];
  const items = [];
  let cur = null;
  let curItem = null;

  const closeItem = () => {
    if (cur && curItem) {
      items.push({
        key: `${cur.key}#${curItem.n}`,
        milestoneKey: cur.key,
        n: curItem.n,
        text: normalize(curItem.text),
        status: itemStatus(curItem.raw),
        statusRaw: normalize(curItem.raw),
      });
    }
    curItem = null;
  };
  const closeMilestone = () => {
    closeItem();
    if (cur) {
      const own = items.filter((i) => i.milestoneKey === cur.key);
      const { lastItemN, ...row } = cur;
      milestones.push({
        ...row,
        total: own.length,
        done: own.filter((i) => i.status === "已完成").length,
        status: milestoneStatus(cur.title, own),
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const mm = MILESTONE_RE.exec(line.trim());
    if (mm) {
      closeMilestone();
      cur = {
        key: mm[1],
        title: stripEmphasis(mm[2]),
        goal: "",
        reference: "",
      };
      continue;
    }
    if (!cur) continue;

    const trimmed = line.trim();
    if (/^[-*]\s/.test(trimmed)) {
      closeItem();
      const body = trimmed.replace(/^[-*]\s+/, "");
      cur.lastItemN = (cur.lastItemN ?? 0) + 1;
      curItem = {
        n: cur.lastItemN,
        raw: body,
        // The marker is state, not content: strip it from the visible text.
        text: body.replace(/^[✅⬜☐🟡⚠️]\s*/, ""),
      };
      continue;
    }
    if (curItem && /^\s{2,}\S/.test(line)) {
      // Wrapped continuation of the previous bullet.
      curItem.text = `${curItem.text} ${stripEmphasis(line)}`;
      continue;
    }
    if (/^目标[：:]/.test(trimmed)) {
      cur.goal = stripEmphasis(trimmed.replace(/^目标[：:]\s*/, ""));
      continue;
    }
    if (/^前置[：:]/.test(trimmed)) {
      cur.goal = normalize(`${cur.goal} ${stripEmphasis(trimmed)}`);
      continue;
    }
    if (/^(PRD|决策|验收)[：:]/.test(trimmed)) {
      cur.reference = normalize(`${cur.reference} ${stripEmphasis(trimmed)}`);
      continue;
    }
  }
  closeMilestone();
  // `验收：...` bullets sometimes start with `- 验收：` — keep them as items,
  // they are still work statements; `reference` only collects bare lines.
  return { milestones, items: items.map((i) => ({ ...i, text: normalize(i.text) })) };
}

/** `## 风险登记` -> rows keyed by the risk text itself. */
export function parseRisks(md) {
  const table = sectionTable(md, "风险登记", ["风险", "影响", "应对"]);
  if (table === null || table.rows.length === 0) return [];
  if (table.headerMismatch) {
    throw new Error(
      `project-plan.md: "## 风险登记" table header changed, got | ${table.header.join(" | ")} |`,
    );
  }
  return table.rows.map((cells, index) => ({
    key: normalize(cells[0]),
    impact: normalize(cells[1]),
    mitigation: normalize(cells[2]),
    order: index + 1,
  }));
}

/** `## 延后清单` -> rows keyed by the deferred item itself. */
export function parseDeferred(md) {
  const table = sectionTable(md, "延后清单", ["项", "原因", "保留方式"]);
  if (table === null || table.rows.length === 0) return [];
  return table.rows.map((cells, index) => ({
    key: normalize(cells[0]),
    reason: normalize(cells[1]),
    seam: normalize(cells[2]),
    order: index + 1,
  }));
}

/** `已验证：` paragraph under 当前状态 — the honest "what is proven today" line. */
export function parseVerifiedNote(md) {
  const lines = sectionLines(md, "当前状态");
  if (lines === null) return "";
  const start = lines.findIndex((l) => l.trim().startsWith("已验证"));
  if (start === -1) return "";
  const buf = [];
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === "" || l.trim().startsWith(">")) break;
    buf.push(l.trim());
  }
  return stripEmphasis(buf.join(" "));
}

/** CONTEXT.md `### Qn — ...` decision log -> count + newest entries. */
export function parseDecisions(md) {
  const headings = [];
  for (const line of md.split("\n")) {
    // `Q5/Q6` is a joint heading; a bracketed char class that omits the second
    // `Q` would silently drop the entry, so match the repeat explicitly.
    const m = /^###\s+((?:Q\d+)(?:\s*\/\s*(?:Q?\d+))*)\s*[—–-]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const numbers = (m[1].match(/\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
    headings.push({
      label: normalize(m[1]),
      numbers,
      title: stripEmphasis(m[2]),
      heading: normalize(line.replace(/^###\s*/, "")),
    });
  }
  const ids = headings.flatMap((h) => h.numbers);
  const latest = headings.at(-1) ?? null;
  return {
    count: ids.length,
    highest: ids.length > 0 ? Math.max(...ids) : 0,
    latestHeading: latest?.heading ?? "",
    entries: headings,
  };
}

/** Everything the Bitable needs, plus the content hash that gates the log row. */
export function buildSnapshot(planMd, contextMd) {
  const phases = parsePhases(planMd);
  const { milestones, items } = parseMilestones(planMd);
  const risks = parseRisks(planMd);
  const deferred = parseDeferred(planMd);
  const verifiedNote = parseVerifiedNote(planMd);
  const decisions = parseDecisions(contextMd);

  const canonical = JSON.stringify(
    {
      phases: phases.map((p) => [p.key, p.name, p.content, p.status, p.order]),
      milestones: milestones.map((m) => [m.key, m.title, m.status, m.goal, m.total, m.done]),
      items: items.map((i) => [i.key, i.text, i.status]),
      risks: risks.map((r) => [r.key, r.impact, r.mitigation]),
      deferred: deferred.map((d) => [d.key, d.reason, d.seam]),
      verifiedNote,
      decisions: { count: decisions.count, highest: decisions.highest },
    },
  );

  return {
    snapshotId: createHash("sha1").update(canonical).digest("hex").slice(0, 12),
    phases,
    milestones,
    items,
    risks,
    deferred,
    verifiedNote,
    decisions,
    stats: {
      phasesDone: phases.filter((p) => p.status === "完成").length,
      phasesTotal: phases.length,
      itemsDone: items.filter((i) => i.status === "已完成").length,
      itemsTotal: items.length,
      milestonesTotal: milestones.length,
      risksTotal: risks.length,
      deferredTotal: deferred.length,
    },
    summary: [
      `阶段 ${phases.filter((p) => p.status === "完成").length}/${phases.length} 完成`,
      `里程碑条目 ${items.filter((i) => i.status === "已完成").length}/${items.length}`,
      `风险 ${risks.length}`,
      `延后 ${deferred.length}`,
      `决策 ${decisions.count} 条（最新 ${decisions.latestHeading || "无"}）`,
    ].join("；"),
  };
}

/* ---------------------------------------------------------------- sync layer */
/* Everything below is still pure: it turns a snapshot + config into a write plan,
 * without touching lark-cli or the filesystem. That is what makes the idempotency
 * contract testable offline. */

/** Feishu Bases in this space use Asia/Shanghai wall clock; label timestamps to match. */
export const TIME_ZONE = "Asia/Shanghai";

export function formatLocalMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Validate the committed Bitable config. Structural only: no network. */
export function validateConfig(config) {
  const problems = [];
  for (const key of ["space_id", "base_title", "tables"]) {
    if (!config[key]) problems.push(`config missing "${key}"`);
  }
  if (!Array.isArray(config.tables) || config.tables.length === 0) {
    problems.push('config "tables" must be a non-empty array');
    return problems;
  }
  const seenTable = new Set();
  for (const t of config.tables) {
    for (const key of ["key", "name", "primaryKey", "fields"]) {
      if (!t[key]) problems.push(`table ${t.key ?? "?"} missing "${key}"`);
    }
    if (seenTable.has(t.name)) problems.push(`duplicate table name: ${t.name}`);
    seenTable.add(t.name);
    const seenField = new Set();
    for (const f of t.fields ?? []) {
      if (!f.name || !f.type) problems.push(`table ${t.name}: field needs name+type: ${JSON.stringify(f)}`);
      if (seenField.has(f.name)) problems.push(`table ${t.name}: duplicate field ${f.name}`);
      seenField.add(f.name);
    }
    if ((t.fields ?? []).some((f) => f.type === "select" && (f.options ?? []).length === 0)) {
      problems.push(`table ${t.name}: select field without options cannot be created`);
    }
    if (!(t.fields ?? []).some((f) => f.name === t.primaryKey)) {
      problems.push(`table ${t.name}: primaryKey "${t.primaryKey}" is not a declared field`);
    }
    if ((t.fields ?? [])[0]?.name !== t.primaryKey) {
      problems.push(`table ${t.name}: primaryKey must be the FIRST field (Base makes it the primary column)`);
    }
  }
  return problems;
}

/** Cell values per field type, following the documented Base CellValue shapes. */
export function coerce(field, value) {
  if (value === undefined || value === null) return null;
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    case "select": {
      const list = Array.isArray(value) ? value : [value];
      const allowed = new Set((field.options ?? []).map((o) => o.name));
      const kept = list.filter((v) => allowed.has(v));
      if (kept.length === 0 && list.length > 0) {
        throw new Error(
          `field "${field.name}" has no matching option for ${JSON.stringify(list)}; declared: ${[...allowed].join(", ")}`,
        );
      }
      return kept.length > 0 ? kept : null;
    }
    case "datetime":
      return String(value);
    case "text":
    default:
      return String(value);
  }
}

/** Render any Base cell value (text, number, select array, link/user object) to comparable text. */
export function cellText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((x) => (typeof x === "object" ? (x?.name ?? x?.id ?? "") : x)).join(",");
  if (typeof value === "object") return String(value.name ?? value.id ?? "");
  return String(value);
}

/** Key column of a read-back record, which may arrive as text or a single-select array. */
export function recordKey(table, rec) {
  return cellText(rec[table.primaryKey]);
}

/** Row sets for one table, from a snapshot. Cell names must match the config. */
export function rowsFor(tableKey, snap) {
  const LIVING = "存在";
  switch (tableKey) {
    case "phases":
      return snap.phases.map((p) => ({
        阶段号: p.key,
        阶段名称: p.name,
        范围: p.content,
        状态: p.status,
        状态原文: p.statusRaw,
        文档顺序: p.order,
        仓库内: LIVING,
      }));
    case "milestones":
      return snap.milestones.map((m) => ({
        里程碑号: m.key,
        标题: m.title,
        目标: m.goal,
        状态: m.status,
        条目总数: m.total,
        已完成条目: m.done,
        完成度: m.total > 0 ? Math.round((m.done / m.total) * 100) / 100 : 0,
        参考: m.reference,
        仓库内: LIVING,
      }));
    case "items":
      return snap.items.map((i) => ({
        条目主键: i.key,
        里程碑号: i.milestoneKey,
        条目序号: i.n,
        内容: i.text,
        状态: i.status,
        仓库内: LIVING,
      }));
    case "risks":
      return snap.risks.map((r) => ({
        风险: r.key,
        影响: r.impact,
        应对: r.mitigation,
        文档顺序: r.order,
        仓库内: LIVING,
      }));
    case "deferred":
      return snap.deferred.map((d) => ({
        项: d.key,
        原因: d.reason,
        保留方式: d.seam,
        文档顺序: d.order,
        仓库内: LIVING,
      }));
    case "overview": {
      const s = snap.stats;
      return [
        {
          总览: "项目",
          阶段完成: s.phasesDone,
          阶段总数: s.phasesTotal,
          条目完成: s.itemsDone,
          条目总数: s.itemsTotal,
          里程碑总数: s.milestonesTotal,
          风险条数: s.risksTotal,
          延后条数: s.deferredTotal,
          决策条数: snap.decisions.count,
          最新决策: snap.decisions.latestHeading,
          已验证: snap.verifiedNote,
          快照: snap.snapshotId,
        },
      ];
    }
    case "changelog":
      return [
        {
          快照: snap.snapshotId,
          同步时间: snap.syncedAt ?? formatLocalMinute(),
          阶段完成: snap.stats.phasesDone,
          条目完成: snap.stats.itemsDone,
          决策条数: snap.decisions.count,
          最新决策: snap.decisions.latestHeading,
          摘要: snap.summary,
        },
      ];
    default:
      throw new Error(`no row builder for table key "${tableKey}"`);
  }
}

/** Only report real differences; select/array and number/string drift normalize away. */
export function diffCells(fields, desired, existing) {
  const patch = {};
  for (const f of fields) {
    const want = desired[f.name];
    if (want === undefined) continue;
    const got = existing?.[f.name];
    if (cellText(want) !== cellText(got)) {
      patch[f.name] = want;
    } else if (f.type === "number" && got !== null && got !== undefined && typeof got !== "number") {
      // Type drift (server returned text for a number column): rewrite once so the
      // next diff is not comparing "8" to 8 forever.
      patch[f.name] = want;
    }
  }
  return patch;
}

/**
 * Write plan for one table given its current records.
 *
 * `appendOnly` tables (进展记录) never patch an existing row: a historical entry is
 * immutable, and the content hash is the idempotency gate — re-running on an
 * unchanged repo adds zero rows. Rows that vanish from a keyed table are flagged
 * 仓库内=已移除 instead of deleted, so nothing a human added to the Base is lost.
 */
export function planTable(table, desired, existingRecords) {
  const byKey = new Map();
  for (const rec of existingRecords) {
    const key = recordKey(table, rec);
    if (key) byKey.set(key, rec);
  }

  const create = [];
  const update = [];
  const covered = new Set();
  for (const row of desired) {
    const key = String(row[table.primaryKey]);
    covered.add(key);
    const rec = byKey.get(key);
    if (!rec) {
      create.push({ key, cells: row });
      continue;
    }
    if (table.appendOnly) continue;
    const patch = diffCells(table.fields, row, rec);
    if (Object.keys(patch).length > 0) update.push({ key, recordId: rec.record_id, patch });
  }

  const stale = [];
  if (!table.appendOnly && table.fields.some((f) => f.name === "仓库内")) {
    for (const [key, rec] of byKey) {
      if (covered.has(key)) continue;
      if (cellText(rec.仓库内) === "已移除") continue;
      stale.push({ key, recordId: rec.record_id });
    }
  }
  return { create, update, stale, unchanged: desired.length - create.length - update.length };
}

/** Cross-check row builders against the declared schema before any write. */
export function schemaProblems(tables, snap) {
  const problems = [];
  for (const t of tables) {
    const declared = new Set(t.fields.map((f) => f.name));
    let desired;
    try {
      desired = rowsFor(t.key, snap);
    } catch (err) {
      problems.push(`table "${t.name}": ${err.message}`);
      continue;
    }
    for (const row of desired) {
      for (const name of Object.keys(row)) {
        if (!declared.has(name)) problems.push(`table "${t.name}": row cell "${name}" is not a declared field`);
      }
      if (!recordKey(t, row)) problems.push(`table "${t.name}": row with empty primary key in "${t.primaryKey}"`);
    }
    const keys = desired.map((r) => recordKey(t, r));
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dup.length > 0) {
      problems.push(`table "${t.name}": duplicate primary keys ${[...new Set(dup)].join(", ")} — upsert would collapse rows`);
    }
  }
  return problems;
}

/**
 * Refuse a sync that would flag most of a table as removed in one run.
 *
 * A renamed or deleted doc section parses to zero rows; without this guard the
 * next sync would stamp every existing Base row 仓库内=已移除, which reads like a
 * real project decision but is usually a parser/authoring accident. Losing a
 * handful of rows is normal; losing most of a table is not.
 */
export function massRemovalProblem(table, plan, existingCount) {
  const flagged = plan.stale.length;
  if (flagged < 3) return null;
  if (existingCount === 0 || flagged / existingCount < 0.5) return null;
  return (
    `table "${table.name}": ${flagged}/${existingCount} existing row(s) would be flagged 已移除. ` +
    `If the docs really dropped them, re-run with --allow-mass-removal; ` +
    `otherwise a section was renamed and the parser found nothing.`
  );
}
