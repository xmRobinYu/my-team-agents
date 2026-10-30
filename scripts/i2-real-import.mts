/**
 * I2 evidence script — imports the REAL teamagentx package and prints what
 * landed, then proves a broken package leaves nothing behind.
 *
 * Run: node --experimental-strip-types scripts/i2-real-import.ts
 * Keep artifacts for inspection: MTA_I2_KEEP=1 node ...
 *
 * Not part of `pnpm test` (vitest only collects packages/**); this is manual
 * evidence for the I2 acceptance criteria.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomStore } from "../packages/orchestrator/src/room-store.ts";
import { importTemplatePackage } from "../packages/orchestrator/src/template-import.ts";

// fflate is declared in packages/orchestrator; reach it there rather than
// adding a root dependency just for an evidence script.
const fflatePath = resolve(
  import.meta.dirname,
  "../packages/orchestrator/node_modules/fflate/esm/browser.js",
);
const { zipSync, strToU8 } = await import(fflatePath);

const ZIP = resolve(import.meta.dirname, "../ref/teamagentx-templates/全栈软件研发-2026-06-03.zip");
if (!existsSync(ZIP)) {
  console.error(`找不到样例包：${ZIP}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "i2-real-import-"));
const store = new RoomStore(join(work, "rooms.sqlite"));
const line = (s = "") => console.log(s);

line("=== I2 真实导入：全栈软件研发-2026-06-03.zip ===");
line(`zip              : ${ZIP}`);

const result = importTemplatePackage({
  zip: ZIP,
  store,
  projectId: "my-team-agents",
  roomsRoot: join(work, ".rooms"),
});

line(`room.id          : ${result.room.id}`);
line(`room.name        : ${result.room.name}`);
line(`room.description : ${result.room.description}`);
line(`room.projectId   : ${result.room.projectId}`);
line(`room.rules       : ${result.room.rules.split("\n").length} 行 Markdown`);
line(`coordinatorAgentId: ${result.room.coordinatorAgentId}`);
line(`协调者判定        : source=${result.coordinator.source}`);
line(`                   ${result.coordinator.rationale}`);
line(`roomRoot         : ${result.roomRoot.replace(work, "<work>")}`);
line("");

line(`agents（snapshot 顺序，共 ${result.agents.length}）:`);
for (const a of result.agents) {
  const skills = readdirSync(join(a.agentDir, "skills"));
  line(
    `  ${a.isCoordinator ? "★" : "·"} ${a.name}（${a.role || "-"}）`
    + `  is_coordinator=${a.isCoordinator}`
    + `  AGENTS.md=${existsSync(join(a.agentDir, "AGENTS.md"))}`
    + `  skills=${skills.length}`,
  );
  line(`      agentDir=${a.agentDir.replace(work, "<work>")}`);
  line(`      emoji=${a.emoji ?? "-"} color=${a.color ?? "-"} thinking=${a.thinkingMode ?? "-"} prompt=${a.prompt.length}B`);
}
line("");
line(`被标记 is_coordinator 的数量: ${result.agents.filter((a) => a.isCoordinator).length}`);
line(`独立 agentDir 数量: ${result.agentDirs.length}`);
line(`写入文件数量: ${result.filesWritten.length}`);

const byField = new Map<string, number>();
for (const f of result.ignoredFields) byField.set(f.field, (byField.get(f.field) ?? 0) + 1);
line(`ignoredFields: ${result.ignoredFields.length} 条，按字段: ${
  [...byField.entries()].sort().map(([k, v]) => `${k}×${v}`).join(", ")}`);
for (const field of ["speechConfig", "proxyConfig", "codexModel", "acpTool", "categories", "cronTasks"]) {
  const hit = result.ignoredFields.find((f) => f.field === field);
  line(`  ${field}: ${hit ? `已记录 — ${hit.reason}` : "!! 未记录"}`);
}
line(`warnings: ${result.warnings.length} 条`);
for (const w of result.warnings) line(`  - [${w.code}] ${w.message}`);
line("");

line("=== 读回（等价于 GET /api/rooms 系列）===");
line(`GET /api/rooms            → ${store.listRooms().map((r) => r.name).join(", ")}`);
line(`GET /api/rooms/:id/agents → ${store.listAgents(result.room.id).length} 个`);
line(`GET /api/rooms/:id/messages → ${store.listMessages(result.room.id).length} 条（新导入应为 0）`);
const reportFile = join(result.roomRoot, "import-report.json");
const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
  coordinator: { agentName: string; source: string };
  agents: Array<{ name: string; isCoordinator: boolean }>;
};
line(`import-report.json → coordinator=${report.coordinator.agentName}(${report.coordinator.source}) agents=${report.agents.length}`);
line(`协调者 AGENTS.md 前 6 行:`);
const coordinatorAgent = result.agents.find((a) => a.isCoordinator);
line(
  readFileSync(join(coordinatorAgent?.agentDir ?? "", "AGENTS.md"), "utf8")
    .split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"),
);
line("");

line("=== 回滚验证 ===");
const cases: Array<[string, () => void]> = [
  ["缺 manifest.json 的包", () => {
    const p = join(work, "no-manifest.zip");
    writeFileSync(p, Buffer.from(zipSync({ "snapshot.json": strToU8("{}") })));
    return importTemplatePackage({ zip: p, store, projectId: "p", roomsRoot: join(work, ".r1") });
  }],
  ["schemaVersion 不支持", () => {
    const p = join(work, "bad-schema.zip");
    writeFileSync(p, Buffer.from(zipSync({
      "manifest.json": strToU8(JSON.stringify({ schemaVersion: "9.9", contents: {} })),
      "snapshot.json": strToU8(JSON.stringify({ room: { id: "r", name: "x" }, agents: [] })),
    })));
    return importTemplatePackage({ zip: p, store, projectId: "p", roomsRoot: join(work, ".r2") });
  }],
  ["snapshot.json 坏 JSON", () => {
    const p = join(work, "bad-json.zip");
    writeFileSync(p, Buffer.from(zipSync({
      "manifest.json": strToU8(JSON.stringify({ schemaVersion: "1.0", contents: {} })),
      "snapshot.json": strToU8('{"room": {"name": "半截"'),
    })));
    return importTemplatePackage({ zip: p, store, projectId: "p", roomsRoot: join(work, ".r3") });
  }],
];
const roomsBefore = store.listRooms().length;
for (const [label, run] of cases) {
  try {
    run();
    line(`  ${label}: !! 未抛错（不该发生）`);
  } catch (err) {
    line(`  ${label}: 明确错误 → ${(err as Error).message.slice(0, 78)}`);
  }
}
const roomsAfter = store.listRooms().length;
line(`  room 数量: ${roomsBefore} → ${roomsAfter}（失败不留半成品）`);
for (const dir of [".r1", ".r2", ".r3"]) {
  const p = join(work, dir);
  line(`  ${dir} 残留: ${existsSync(p) ? readdirSync(p) : "无"}`);
}

store.close();
if (process.env.MTA_I2_KEEP === "1") line(`\n产物保留在 ${work}`);
else rmSync(work, { recursive: true, force: true });
