#!/usr/bin/env node
/**
 * PRD §6 验收门禁 —— 多 Agent 群聊（P8 / I10）在**真实模型**下的端到端验收。
 *
 * 沿用 `scripts/pi-smoke.sh` 的既定约定：
 *   - 真实 `pi` 二进制 + `~/.pi/agent/models.json` 里的真实 provider；
 *   - 默认模型 `airouter/deepseek-v4.1-flash`，用 `PI_SMOKE_MODEL=<provider>/<model>` 覆盖；
 *   - 隔离工作区（mkdtemp 到 /tmp）：真实 agent 会读写文件，绝不在仓库目录里跑；
 *   - 退出码 0 仅当六项全部 PASS；任一未通过都如实打印 FAIL/BLOCKED 并给出证据。
 *
 * 诚实性规则：
 *   - 六项一律跑真实服务端（`buildApp` + HTTP）与真实 durable worker（**独立进程**，
 *     `packages/server/dist/worker.js`），共享同一个 SQLite 文件；`MTA_RUNTIME=mock` 直接拒绝。
 *   - 每项打印可核对的证据：模型原文片段、DB 行、worker pid/退出码、usage 数字。
 *   - 真实模型不配合（不肯 @ 人、不肯形成回边）时报 BLOCKED 并贴原始输出；
 *     绝不降级为 mock、绝不放宽断言、绝不把 mock 级证明写成真实模型通过。
 *
 * 模型选择：`全栈软件研发` 包里每个 agent 的 declaredModel 被导入器显式忽略（只记录不
 * 应用），`room_agents.model` 因此为空，不设的话 pi 会用它自己的默认模型。本脚本把
 * `PI_SMOKE_MODEL` 写进 `room_agents.model` —— 平台支持的每-agent 模型配置缝
 * （`postRoomMessage` / `personaFields` 会带到 RunSpec），与 pi-smoke 用环境变量覆盖
 * 默认模型是同一件事。全程不读取、不打印任何凭据内容。
 *
 * 用法：
 *   node scripts/prd-acceptance.mjs
 *   PI_SMOKE_MODEL=airouter/deepseek-v4.1-flash MTA_I10_ITEMS=1,6 node scripts/prd-acceptance.mjs
 *   MTA_I10_KEEP=1 node scripts/prd-acceptance.mjs    # 保留 /tmp 产物用于核对
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { findBin } from "./resolve-bin.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const MODEL = process.env.PI_SMOKE_MODEL || "airouter/deepseek-v4.1-flash";
const ZIP = join(ROOT, "ref", "teamagentx-templates", "全栈软件研发-2026-06-03.zip");
const WORKER_ENTRY = join(ROOT, "packages", "server", "dist", "worker.js");
const ITEM_MS = Number(process.env.MTA_I10_ITEM_MS || 300_000); // 单项硬上限：5 分钟
const PREFLIGHT_MS = Number(process.env.MTA_I10_PREFLIGHT_MS || 180_000); // 预检硬上限：3 分钟
const ONLY = (process.env.MTA_I10_ITEMS || "").split(",").map((s) => s.trim()).filter(Boolean);
const RUNTIME_ENV = process.env.MTA_RUNTIME;

const abort = (msg, hint) => {
  console.error(`\nABORT: ${msg}${hint ? `\n  ${hint}` : ""}`);
  process.exit(2);
};

// --- 前置：必须真实模型，不是 mock ----------------------------------------
if (RUNTIME_ENV === "mock") abort("MTA_RUNTIME=mock：本脚本只接受真实 runtime");
delete process.env.MTA_RUNTIME; // 传给 worker 子进程的 env 也不能带 mock
if (!existsSync(ZIP)) abort(`找不到模板包：${ZIP}`, "ref/ 是 git-ignored 的只读参考树。");
if (!existsSync(WORKER_ENTRY)) abort(`找不到真实 worker：${WORKER_ENTRY}`, "先跑 just build。");
// pi 和 lark-cli 一样：装在装它时那个 node 版本的全局 bin 里。当前 shell 若是别的
// node 版本（fnm 下很常见），PATH 就不含该目录，于是 `pi` 报"不可用"，而真实原因不是
// 没装。这里按绝对路径解析，并把它的目录**前置进 PATH** —— 必须改 PATH 而不是只改
// 本脚本，因为真正 spawn `pi` 的是独立进程的 worker（PiAdapter 用裸 "pi"），
// 它继承的是 process.env。
const PI_BIN = findBin("pi");
if (!PI_BIN) {
  abort("pi 二进制不可用", "npm i -g --ignore-scripts @earendil-works/pi-coding-agent");
}
process.env.PATH = `${dirname(PI_BIN)}${delimiter}${process.env.PATH ?? ""}`;
try {
  execFileSync(PI_BIN, ["--version"], { stdio: "pipe", timeout: 20_000 });
} catch (err) {
  // 这里不能用 clip()：它定义在下面，const 在 TDZ 里，catch 会抛 ReferenceError 而不是干净退出。
  abort(`pi 无法执行（${PI_BIN}）：${String(err?.message ?? err).slice(0, 160)}`,
    "npm i -g --ignore-scripts @earendil-works/pi-coding-agent");
}
if (!existsSync(join(process.env.HOME || "", ".pi", "agent", "models.json"))) {
  abort("缺少 provider 配置 ~/.pi/agent/models.json");
}

const { ExecutionStore, RoomStore, createDurableWorker, buildRoomPrompt, resolveMentions } =
  await import(join(ROOT, "packages/orchestrator/dist/index.js"));
const { buildApp } = await import(join(ROOT, "packages/server/dist/app.js"));
const { runtimeFor } = await import(join(ROOT, "packages/server/dist/runtime.js"));

// --- 隔离工作区 + 一个共享 SQLite ----------------------------------------
const WORK = mkdtempSync(join(tmpdir(), "i10-acceptance-"));
const WS = join(WORK, "workspace");
const ROOMS = join(WORK, "rooms");
const DB = join(WORK, "execution.sqlite");
mkdirSync(WS, { recursive: true });
mkdirSync(ROOMS, { recursive: true });

const store = new ExecutionStore(DB);
const rooms = new RoomStore(store.db);
const log = (s = "") => console.log(s);
const kv = (s) => log(`      ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString("hex");
const clip = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const rel = (s) => String(s ?? "").replace(WORK, "<work>").replace(ROOT, "<repo>");
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "blocked"]);

/**
 * D3 验收：会话文件到底落在哪儿。
 *
 * 每个真实 run 的 cwd 是 workspace 或某个 persona dir，Pi 会把全局 sessions 目录
 * 按 cwd 编码成一个名字（`/var/…/x` → `--var-…-x--`）。因为 WORK 是随机 mkdtemp，
 * 这个编码串就是本次运行的唯一指纹：全局目录里只要出现含它的条目，就说明
 * `--session-dir` 没生效。只列目录名，绝不读文件内容（可能含 prompt 原文）。
 */
const GLOBAL_SESSIONS = join(process.env.HOME || "", ".pi", "agent", "sessions");
const workspaceToken = WORK.split("/").filter(Boolean).at(-1) ?? "";
const globalSessionEntries = () => {
  try {
    return readdirSync(GLOBAL_SESSIONS).filter((d) => workspaceToken && d.includes(workspaceToken));
  } catch { return []; }
};
const personaSessionFiles = (agentDir) => {
  const dir = join(agentDir, ".pi", "sessions");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch { return []; }
};

// --- 真进程 worker ---------------------------------------------------------
const workers = [];
function spawnWorker(tag) {
  const logFile = join(WORK, `worker-${tag}.log`);
  const fd = openSync(logFile, "a");
  const proc = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: ROOT,
    detached: true, // 独立进程组：杀 worker 连它的 pi 子进程一起杀
    stdio: ["ignore", fd, fd],
    env: { ...process.env, MTA_DB_PATH: DB },
  });
  const rec = { tag, pid: proc.pid, logFile, proc, exit: null };
  proc.on("exit", (code, signal) => { rec.exit = { code, signal }; });
  workers.push(rec);
  return rec;
}
function killWorker(rec, signal = "SIGKILL") {
  if (!rec?.pid) return "no-pid";
  try { process.kill(-rec.pid, signal); return `SIGKILL 进程组 -${rec.pid}`; }
  catch { try { process.kill(rec.pid, signal); return `SIGKILL pid ${rec.pid}`; } catch { return "已经死了"; } }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tail = (file, n = 600) => { try { return clip(readFileSync(file, "utf8").slice(-n), n); } catch { return "(无日志)"; } };

async function waitFor(fn, timeoutMs, interval = 400) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(interval);
  }
}

// --- 读证据的小工具 --------------------------------------------------------
const roomTasks = (roomId) => store.listTasks(2000).filter((t) => t.groupId === roomId);
const agentName = (id) => rooms.getAgent(id)?.name ?? id;
const taskLine = (t) => `task=${t.id.slice(0, 13)} member=${agentName(t.memberId)} status=${t.status} depth=${t.depth}`
  + ` attempts=${t.batchAttempts} parent=${t.parentTaskId ? agentName(t.parentTaskId) : "-"}`
  + ` idem=${t.idempotencyKey ?? "-"} agentDir=${rel(t.agentDir)}`;
const msgsOf = (roomId, kind, agentId) => rooms.listMessages(roomId)
  .filter((m) => m.authorKind === kind && (!agentId || m.authorAgentId === agentId));
const sysMsgs = (roomId, needle) => rooms.listMessages(roomId)
  .filter((m) => m.authorKind === "system" && m.content.includes(needle));
const dumpTasks = (ev, roomId) => {
  const ts = roomTasks(roomId);
  ev.push(`tasks 表里本群的行（共 ${ts.length}）：`);
  for (const t of ts) ev.push(`  · ${taskLine(t)}`);
};
const dumpStream = (ev, roomId) => {
  ev.push(`room_messages 全流（可逐行核对作者与内容）：`);
  for (const m of rooms.listMessages(roomId)) {
    const who = m.authorKind === "agent" ? agentName(m.authorAgentId) : m.authorKind;
    ev.push(`  · [seq ${m.seq}] ${who}${m.taskId ? `(task=${m.taskId.slice(0, 11)})` : ""}: ${clip(m.content, 300)}`);
  }
};
const historySection = (taskId) => {
  const p = store.getTask(taskId)?.prompt ?? "";
  const i = p.indexOf("# 群聊记录");
  return i < 0 ? "(注入的 prompt 里没有「# 群聊记录」段)" : p.slice(i, i + 600).split("\n").join(" ⏎ ");
};

/**
 * 某个 Task 里模型真实说了什么。成功时是群里的回复；失败时 Q39 规定"失败不发言"，
 * 模型原文只留在 tasks.error（structured.summary）与 events 里 —— 阴性对照常常正是
 * 以"拒绝编造"的形式失败的，只看 room_messages 会把这条最有价值的证据丢掉。
 */
const modelText = (taskId) => {
  if (!taskId) return "";
  const t = store.getTask(taskId);
  const spoken = t?.groupId ? rooms.getMessageByTask(t.id)?.content : null;
  const evText = store.getEvents(t.id, 0, 2000).filter((e) => e.event.text).map((e) => e.event.text);
  return [spoken, t?.result?.summary, t?.error, evText.at(-1)].filter(Boolean).join(" ⇢ ");
};
/** 某个 Task 里模型真实调用过哪些工具（用于证明它有没有绕过"不要用工具"）。 */
const toolCallsOf = (taskId) => {
  if (!taskId) return [];
  return store.getEvents(taskId, 0, 2000)
    .filter((e) => e.event.type === "tool_execution_start" && e.event.toolName)
    .map((e) => `${e.event.toolName}${e.event.args ? `(${clip(JSON.stringify(e.event.args), 120)})` : ""}`);
};
/**
 * 无事件超时（stall watchdog：`durable-worker.ts` 的 `no events for <ms>ms`）是
 * **provider 挂起**的形状，不是模型「不肯说话」的形状。
 *
 * 提到模块作用域是因为两处误诊都源于没把它单独拎出来：
 *   - r7 的 `status=failed attempts=3` 被我读成"协调者没输出 [讨论结束]"，
 *     实际是三次 Attempt 各撞一次无事件超时 —— 协调者根本没拿到模型响应；
 *   - 之后我又把一次饿死读成"预算耗尽"。
 * 判定分层（FAIL 只留给守卫真的漏放）依赖这个区分，所以每个 item 都必须用同一个。
 */
const hungWithoutEvents = (taskId) => taskId
  ? store.getAttempts(taskId).some((a) => (a.error ?? "").includes("no events for"))
  : false;

/** 一个 Task 最后一次 Attempt 的错误 —— BLOCKED 的原因必须具名，不能只说"没观察到"。 */
const lastAttemptError = (taskId) => {
  if (!taskId) return "";
  const attempts = store.getAttempts(taskId);
  const failed = attempts.filter((a) => a.error);
  return clip((failed.at(-1) ?? attempts.at(-1))?.error ?? "", 160);
};

/**
 * 「该看到的证据没看到」的分诊：把基础设施故障、队列饿死、模型不配合和守卫真的
 * 漏放分开，每个都给具名原因。
 *
 * 这个函数存在的理由是两次真实误诊：同一个"没观察到"，我先归因成"模型不肯收尾"，
 * 又归因成"预算耗尽"，两次都错（真因分别是 provider 无事件超时、串行队列饿死）。
 * 混成一句"未命中"就会持续产出这种结论，所以判定必须按形状分派，而不是按结果猜。
 *
 * 返回 kind：
 *   hung    provider 无事件超时（stall watchdog）—— 与产品行为无关
 *   starved 任务停在 queued：worker 被别的在飞 Task 占住，或预算不足没领取
 *   silent  任务成功但没产出可判定的回复 —— 模型不配合指令
 *   failed  任务终态是 failed/cancelled/blocked，带上最后一次 Attempt 的错误
 *   null    任务确实成功且有回复：这里没有"未观察到"要解释
 */
const triageUnobserved = (taskId, { hasReply } = {}) => {
  if (!taskId) return { kind: "absent", why: "没有对应的 Task 可查" };
  const task = store.getTask(taskId);
  if (!task) return { kind: "absent", why: "Task 行不存在" };
  if (hungWithoutEvents(taskId)) {
    return { kind: "hung", why: `Attempt 撞了无事件超时（provider 挂起）：${lastAttemptError(taskId) || "no events"}` };
  }
  if (task.status === "queued" || task.status === "retry_wait") {
    const inFlight = store.listTasks(2000).filter((t) => t.status === "running");
    const hung = inFlight.filter((t) => hungWithoutEvents(t.id)).length;
    return {
      kind: "starved",
      why: inFlight.length > 0
        ? `停在 ${task.status}，而 worker 被 ${inFlight.length} 个在飞 Task 占住（队列串行，一次只领一个）`
          + `${hung ? `，其中 ${hung} 个已撞无事件超时` : ""} —— 与守卫无关`
        : `停在 ${task.status} 而 worker 空闲：单项预算不足或未被领取`,
    };
  }
  if (task.status !== "succeeded") {
    return { kind: "failed", why: `终态=${task.status}：${lastAttemptError(taskId) || "（无错误记录）"}` };
  }
  if (!hasReply) return { kind: "silent", why: "任务成功，但群里没有它的发言（模型未按指令产出 summary）" };
  return null;
};

/** 提醒模型遵守平台结构化契约：只有 outcome=success 的结构化结果才会被发回群里。 */
const SAY = `你的最终结构化结果必须用 outcome="success"，并把你要在群里说的话原样放进 summary（失败不会有人看到你的话）。`;

/** 群安静 = 本群所有 Task 终态，且任务集合连续 quietMs 不变（子 Task 在同事务入队）。 */
async function settleRoom(roomId, timeoutMs, quietMs = 3000) {
  const end = Date.now() + timeoutMs;
  let lastKey = null;
  let stableSince = Date.now();
  for (;;) {
    const tasks = roomTasks(roomId);
    const key = tasks.map((t) => `${t.id}:${t.status}:${t.batchAttempts}`).join("|");
    const idle = tasks.length > 0 && tasks.every((t) => TERMINAL.has(t.status));
    if (idle && key === lastKey && Date.now() - stableSince >= quietMs) return tasks;
    if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
    if (Date.now() >= end) return tasks;
    await sleep(400);
  }
}

// --- 真实服务端 ------------------------------------------------------------
async function startServer() {
  // 只为 /api/tasks/:id/cancel 这条 seam 提供 worker.requestCancel（与
  // packages/server/src/server.ts 的接线等价）；真正执行 Task 的是独立进程 worker。
  const seam = createDurableWorker(store, { adapterFor: runtimeFor, rooms });
  const app = await buildApp({
    store, worker: seam, rooms,
    roomsRoot: ROOMS,
    defaultProjectId: "i10-acceptance",
    defaultWorkspacePath: WS,
    defaultTenantId: "i10",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function post(base, roomId, content) {
  const res = await fetch(`${base}/api/rooms/${roomId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, workspacePath: WS }),
  });
  return { status: res.status, body: await res.json() };
}

/** 真实导入一个新群（POST /api/rooms/import 走真实 zip 解析），并配置每-agent 模型。 */
async function importRoom(base, projectId) {
  const res = await fetch(`${base}/api/rooms/import`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: ZIP, projectId }),
  });
  const body = await res.json();
  if (res.status !== 201) return { error: `HTTP ${res.status} ${clip(JSON.stringify(body), 300)}` };
  store.db.prepare("UPDATE room_agents SET model = ? WHERE room_id = ?").run(MODEL, body.room.id);
  return { id: body.room.id, room: rooms.getRoom(body.room.id), agents: rooms.listAgents(body.room.id), import: body };
}
const byRole = (h, role) => h.agents.find((a) => a.role === role) ?? null;

// --- 结果记录 --------------------------------------------------------------
const results = [];
function record(n, title, status, ev) {
  results.push({ n, title, status });
  log(`\n[${n}] ${title}`);
  log(`    ⇒ ${status}`);
  for (const e of ev) kv(e);
}
const want = (n) => ONLY.length === 0 || ONLY.includes(String(n));
const failFast = (n, title, why) => { record(n, title, "FAIL", [why]); return null; };

// ===== 1. 导入 5 agent（不需要模型） ======================================
async function item1(base) {
  const ev = [];
  const title = "导入 全栈软件研发 → 含 5 个 agent 的 ChatRoom";
  const h = await importRoom(base, "i10-item1");
  if (h.error) return failFast("1", title, `POST /api/rooms/import 失败：${h.error}`);
  const fetched = await (await fetch(`${base}/api/rooms/${h.id}/agents`)).json();
  const listed = await (await fetch(`${base}/api/rooms`)).json();
  ev.push(`POST /api/rooms/import → HTTP 201；room=${h.id} name=${h.room.name} maxRounds=${h.room.maxRounds} rules=${h.room.rules.split("\n").length} 行 Markdown`);
  ev.push(`GET /api/rooms → ${listed.map((r) => r.name).join(", ")}`);
  ev.push(`GET /api/rooms/:id/agents → ${fetched.length} 个：`);
  for (const a of h.agents) {
    ev.push(`  · ${a.name}（${a.role}）is_coordinator=${a.isCoordinator} agentDir=${rel(a.agentDir)} AGENTS.md=${existsSync(join(a.agentDir, "AGENTS.md")) ? "已落盘" : "缺失"}`);
  }
  const coord = h.agents.filter((a) => a.isCoordinator);
  const onDisk = h.agents.filter((a) => existsSync(join(a.agentDir, "AGENTS.md")));
  const distinct = new Set(h.agents.map((a) => a.agentDir)).size;
  ev.push(`协调者：${coord.length === 1 ? `${coord[0].name}（${coord[0].role}）is_coordinator=1` : `count=${coord.length}`}；判定来源=${h.import.coordinator.source}；chat_rooms.coordinator_agent_id=${h.room.coordinatorAgentId}`);
  ev.push(`独立 agentDir=${distinct}/5；落盘 AGENTS.md=${onDisk.length}/5；写入文件 ${h.import.filesWritten.length} 个；warnings=${h.import.warnings.length}`);
  ev.push(`事实说明：该包不含任何技能（I9 已断言：zip 5 个条目、无 skills/）。§6 第 1 项只要求 5 个 agent，不要求技能。`);
  const ok = fetched.length === 5 && h.agents.length === 5 && coord.length === 1
    && coord[0].id === h.room.coordinatorAgentId && onDisk.length === 5 && distinct === 5;
  record("1", title, ok ? "PASS" : "FAIL", ev);
  return h;
}

// ===== 2. @架构师 + 群上下文（含阴性对照） =================================
//
// 第一版在这里被判过 FAIL，两条原因，本版都堵掉：
//  1) marker 让模型"现编" —— 同一 provider 几乎每次都编出同一个串，正例与阴性对照失去
//     区分力（实测三次全是 QX7f3a9c2e5b1d）。改成脚本 randomBytes 生成。
//  2) 阴性对照里架构师翻磁盘把 marker 读了出来（它去读了另一个群的 Pi 会话日志并复述
//     原值）。所以 (a) 阴性对照**先跑** —— 那一刻 marker 还没进过任何会话文件/DB 行，
//     磁盘上根本没有可偷看的东西；(b) 题面明确禁止一切读取类工具；(c) 打印每个 Task
//     的真实工具调用作为证据。
async function item2(base) {
  const ev = [];
  const title = "用户 @架构师 → 以自身身份回复且明显使用群上下文（含阴性对照）";
  let deadline = Date.now() + ITEM_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const marker = `QX${hex(8)}`;
  ev.push(`marker=${marker}（脚本 randomBytes 生成的 16 位十六进制；不来自模型、不来自训练语料，跑起来之前不在任何磁盘文件里）`);
  // D2 已修（PRD §6 第 2 项字面就是「@架构师」这个角色名，不是人名）。断言见下方【正例】段。
  const q = (token) => `@${token} 只回答一件事：刚才群里许清楚给出的验证码是什么？只回复验证码本身，不要解释。`
    + `绝对不许使用任何工具 —— 不准 read、不准 bash、不准 ls/find/cat/grep，不准去翻任何会话文件或日志：`
    + `这道题只许用你本次被注入的群聊上下文来回答，靠翻文件得到的答案算错；上下文里没有就老实说没有。${SAY}`;
  const ROLE_TOKENS = ["架构师", "产品经理", "QA工程师", "交付总监", "工程师"];
  const d2Line = (token, agents) => {
    const hit = resolveMentions(`@${token} 在吗`, agents).targets;
    return `  · 解析 "@${token}" → ${hit.length ? hit.map((a) => `${a.name}（${a.role}）`).join(" | ") : "未命中"}`
      + `｜唯一命中=${hit.length === 1}${hit.length === 1 ? `｜角色相符=${hit[0].role === token || hit[0].name === token}` : ""}`;
  };

  // ---- 阴性对照先跑 ----
  const neg = await importRoom(base, "i10-item2-neg");
  const negArch = neg.error ? null : byRole(neg, "架构师");
  let negLeaked = null;
  if (!negArch) {
    ev.push(`阴性对照未能建立（${neg.error ?? "缺架构师"}）→ 没有阴性对照的本项不算通过。`);
  } else {
    const n1 = await post(base, neg.id, q("架构师"));
    ev.push(`【阴性对照，先跑】群=${neg.id} HTTP ${n1.status}：这个群里没有任何许清楚的发言，注入历史里不存在 marker`);
    await settleRoom(neg.id, left());
    const negTask = roomTasks(neg.id).find((x) => x.memberId === negArch.id);
    const negMsg = msgsOf(neg.id, "agent", negArch.id).at(-1);
    negLeaked = [negMsg?.content, modelText(negTask?.id)].filter(Boolean).join(" ").includes(marker);
    ev.push(`阴性对照注入的群历史（逐字片段）：${clip(historySection(negTask?.id), 460)}`);
    ev.push(`阴性对照架构师进群回复：${clip(negMsg?.content, 320) || "（无回复）"}`);
    ev.push(`阴性对照模型原始输出（status=${negTask?.status} attempts=${negTask?.batchAttempts}）：${clip(modelText(negTask?.id), 460) || "（空）"}`);
    ev.push(`阴性对照真实工具调用：${toolCallsOf(negTask?.id).length ? toolCallsOf(negTask?.id).join(" ; ") : "（无 —— 没有翻磁盘）"}`);
    ev.push(`阴性对照是否说出 marker=${negLeaked}（必须 false）`);
  }

  // ---- 正例：先把含 marker 的话放进群里（真实模型复述），再 @架构师 ----
  const h = await importRoom(base, "i10-item2-pos");
  if (h.error) return failFast("2", title, [...ev, `导入失败：${h.error}`]);
  const pm = byRole(h, "产品经理"), arch = byRole(h, "架构师");
  if (!pm || !arch) return failFast("2", title, [...ev, `群里缺 产品经理/架构师：${h.agents.map((a) => a.role).join(",")}`]);
  ev.push(`【正例】群=${h.id}；${pm.name}（产品经理）先发言，随后 ${arch.name}（架构师）被 @`);
  // ---- D2 断言：五个角色各自唯一命中，且名字优先于角色 ----
  ev.push(`【D2】resolveMentions 角色解析（对刚导入的真实 5 agent 名单跑）：`);
  for (const token of ROLE_TOKENS) ev.push(d2Line(token, h.agents));
  const d2Ok = ROLE_TOKENS.every((t) => resolveMentions(`@${t} 在吗`, h.agents).targets.length === 1);
  const archByName = resolveMentions(`@${arch.name} 在吗`, h.agents).targets;
  ev.push(d2Line(arch.name, h.agents) + `｜名字解析到的正是架构师=${archByName.length === 1 && archByName[0].id === arch.id}`);
  const r1 = await post(base, h.id,
    `@${pm.name} 群里同步一条公告：本次需求评审的验证码是 ${marker}。请用一行“验证码：<逐字照抄那个串>”确认你看到了它。不要用任何工具。${SAY}`);
  ev.push(`turn1 HTTP ${r1.status}；tasks=${(r1.body.tasks ?? []).map((t) => t.id.slice(0, 13)).join(",") || "-"}；blocked=${JSON.stringify(r1.body.blocked ?? [])}`);
  await settleRoom(h.id, left());
  const pmTask = roomTasks(h.id).find((x) => x.memberId === pm.id);
  const pmSpoken = msgsOf(h.id, "agent", pm.id).map((m) => m.content).join(" / ");
  const pmSaid = !!pmSpoken && pmSpoken.includes(marker);
  ev.push(`${pm.name} 进群的真实回复（这一条才会被注入给架构师）：${clip(pmSpoken, 300) || "（无 —— 模型没成功发言）"}｜群历史里现已含 marker=${pmSaid}`);
  ev.push(`${pm.name} 真实工具调用：${toolCallsOf(pmTask?.id).length ? toolCallsOf(pmTask?.id).map((t) => t.split("(")[0]).join(",") : "（无）"}`);

  // PRD 字面：@架构师（角色）。D2 修复后应解析到 高见远。
  const r2 = await post(base, h.id, q("架构师"));
  ev.push(`turn2 HTTP ${r2.status}；tasks=${(r2.body.tasks ?? []).map((t) => t.id.slice(0, 13)).join(",") || "-"}（只 @ 架构师 → 只建 1 个 Task，AC2.1）`);
  dumpTasks(ev, h.id);
  const archTask = roomTasks(h.id).find((t) => t.memberId === arch.id);
  ev.push(`注入给架构师的群历史（tasks.prompt 逐字片段）：${clip(historySection(archTask?.id), 620)}`);
  await settleRoom(h.id, left());
  const archMsg = msgsOf(h.id, "agent", arch.id).at(-1);
  ev.push(`架构师进群回复：${archMsg ? `[seq ${archMsg.seq}] author_kind=${archMsg.authorKind} author_agent_id=${archMsg.authorAgentId?.slice(0, 13)}（== 架构师 id：${archMsg.authorAgentId === arch.id}）内容=${clip(archMsg.content, 320)}` : "（无 —— 模型没成功发言）"}`);
  ev.push(`架构师真实工具调用：${toolCallsOf(archTask?.id).length ? toolCallsOf(archTask?.id).join(" ; ") : "（无 —— 只用注入上下文作答，符合题面）"}`);
  const identityOk = !!archMsg && archMsg.authorKind === "agent" && archMsg.authorAgentId === arch.id;
  const personaOk = !!archTask && archTask.agentDir === arch.agentDir;
  ev.push(`身份证据：task.member_id=${archTask?.memberId?.slice(0, 13)}（${agentName(archTask?.memberId ?? "")}）；task.agent_dir=${rel(archTask?.agentDir)} == 架构师自己的 agentDir（Pi 子进程 cwd，Q38）→ ${personaOk}`);
  const usedContext = !!archMsg && archMsg.content.includes(marker);
  ev.push(`正例：架构师引用了 marker=${usedContext}`);
  ev.push(`对照结论：正例（群里有那句话）引用=${usedContext}；阴性对照（群里没有那句话，且先于 marker 落盘运行）说出=${negLeaked}。`
    + `两者同时成立才证明它靠本次注入的群上下文作答 —— 不是猜的（随机串猜不到），也不是翻磁盘（当时磁盘上没有）。`);

  // ---- D3 断言：会话文件只在 persona 自己的目录里，全局 sessions 里没有本次指纹 ----
  const globalLeft = globalSessionEntries();
  const personaFiles = { [arch.name]: personaSessionFiles(arch.agentDir), [pm.name]: personaSessionFiles(pm.agentDir) };
  const negPersonaFiles = negArch ? personaSessionFiles(negArch.agentDir) : [];
  ev.push(`D3 隔离核对：全局 ~/.pi/agent/sessions 里含本次 workspace 指纹「${workspaceToken}」的条目=${globalLeft.length}（必须 0）`
    + `${globalLeft.length ? `：${globalLeft.join(", ")}` : ""}`);
  for (const [name, files] of Object.entries(personaFiles)) {
    ev.push(`  · ${name} 自己的 <agentDir>/.pi/sessions 下会话文件=${files.length} 个${files.length ? `（${files.map((f) => f.split("/").slice(-1)[0]).join(", ")}）` : ""}`);
  }
  if (negArch) ev.push(`  · 阴性对照群 ${negArch.name} 的 persona 会话文件=${negPersonaFiles.length} 个`);
  const d3Ok = globalLeft.length === 0
    && personaFiles[arch.name].length > 0 && personaFiles[pm.name].length > 0
    && (!negArch || negPersonaFiles.length > 0);

  dumpStream(ev, h.id);
  // 分层判定（与 item 5 同一规则）：架构师产出了可判定的回复、而断言与观察不符，
  // 才是真失败；回复根本没到位就先分诊出原因，报 BLOCKED 而不是 FAIL —— 把
  // provider 挂起或队列饿死写成被测系统的失败，是这里犯过两次的错。
  // archTask 是 settle 之前读的快照，所以分诊函数按 id 重读，而不是信这份快照。
  const archTriage = triageUnobserved(archTask?.id, { hasReply: !!archMsg });
  const unobservable = !!archTriage;
  const ok = usedContext && identityOk && personaOk && pmSaid && negLeaked === false && d2Ok && d3Ok;
  record("2", title, ok ? "PASS" : unobservable ? "BLOCKED" : "FAIL", [...ev,
    `本项断言：D2 五个角色各唯一命中=${d2Ok}；D3 全局零泄漏且 persona 目录内有会话=${d3Ok}`,
    ok ? "" : unobservable
      ? `本项 BLOCKED 的原因（${archTriage.kind}）：${arch.name} 的 Task ${archTriage.why}`
      : `架构师已产出回复，但断言与观察不符 —— 真失败：引用群上下文=${usedContext}、`
        + `身份正确=${identityOk}、persona 正确=${personaOk}、${pm.name} 有回应=${pmSaid}、`
        + `阴性对照未泄漏=${negLeaked === false}`]);
}

// ===== 3. agent 间自动交接 ================================================
//
// §6 第 3 项必须证的是 **handoff_to 主路径**（D1 的唯一端到端证明）。判别点：
// outbox.source_tool_call_id 是运行时真实 toolCallId（call_00_…），不是次路径合成的
// mention:<taskId>。
//
// 这一版把 D5-b 与 D6 从"只有单测"变成真实模型证据：
//  · D5-b：注入 prompt 的「# 成员」行现在带 `｜id: agent-…`。所以阶段A **故意不在用户
//    消息里给 id** —— 模型只能从花名册读。断言：父 prompt 里确实带 id；模型不调 handoff_to
//    之外的查找工具（若仍出现 bash/read，就是 D5-b 没真正解决，如实报）。
//  · D6：主路径子 Task 现在也拿到完整群注入。断言：child.prompt 含「# 群聊记录」、含父这条
//    回复原文、且 workPackage 以「# 交接任务说明」附在最后。
//  · D5-a：阶段B 让模型往 toMemberIds 里写**名字**，断言平台解析成真实 agent id（三种形式
//    都接受），而不是像修复前那样把名字当 id 建出一个空转的子 Task。
//
// 沿用两个已踩过的坑：用户消息不得出现可解析的目标提及（否则测的是去重）；读证据前必须等
// 子 Task 进终态。workPackage 要求"只回一句话"，断言的是机制不是实现能力。

async function item3(base) {
  const ev = [];
  const title = "agent 间自动交接走 handoff_to 主路径（真实模型，含 D5-b/D6/D5-a）";
  const deadline = Date.now() + ITEM_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const h = await importRoom(base, "i10-item3");
  if (h.error) return failFast("3", title, `导入失败：${h.error}`);
  const arch = byRole(h, "架构师"), eng = byRole(h, "工程师");
  if (!arch || !eng) return failFast("3", title, `缺 架构师/工程师：${h.agents.map((a) => a.role).join(",")}`);
  const engId = eng.id, archId = arch.id;
  // 只算"去磁盘上找东西"的只读发现类工具：D5-b 的断言是模型不必翻文件就能拿到 id。
  const LOOKUP = new Set(["bash", "read", "ls", "grep", "find"]);
  ev.push(`群=${h.id}；发起者=${arch.name}（${arch.role}），接收者=${eng.name}（${eng.role}，id=${engId}）`);
  ev.push(`判定标准：outbox.source_tool_call_id 是真实 toolCallId（^call_）而非 mention:<taskId>；`
    + `子 Task depth=1、member_id=工程师 id、agent_dir=工程师自己的目录、status=succeeded`);

  const waitChild = (taskId) => waitFor(() => {
    const t = store.getTask(taskId);
    return t && TERMINAL.has(t.status) ? t : null;
  }, left(), 1000);

  const readRun = (parent, label) => {
    const evs = store.getEvents(parent.id, 0, 5000);
    const calls = evs.filter((e) => e.event.type === "tool_execution_start");
    const names = [...new Set(calls.map((c) => c.event.toolName))];
    const handoffs = calls.filter((e) => e.event.toolName === "handoff_to");
    const outbox = store.getOutbox(parent.id);
    ev.push(`${label}：模型调用的工具=[${names.join(", ") || "无"}]；handoff_to ${handoffs.length} 次`);
    for (const c of handoffs) ev.push(`   · toolCallId=${c.event.toolCallId} args=${clip(JSON.stringify(c.event.args), 320)}`);
    // 非 handoff 的调用同样必须打印参数：D5-b 判的是"模型没去翻磁盘找 id"，只报一个
    // 工具名（例如 bash）无法区分"翻花名册失败后的兜底查找"和"与本题无关的一次执行"。
    // 没有 args 的 FAIL 是不可解读的，而不可解读的结论既不能用来定位缺陷，也不能用来
    // 证明修复 —— 上一轮就因此卡在第 3 项。
    for (const c of calls.filter((e) => e.event.toolName !== "handoff_to")) {
      ev.push(`   · 非交接调用 ${c.event.toolName} args=${clip(JSON.stringify(c.event.args ?? {}), 320)}`);
    }
    ev.push(`${label}：outbox=${outbox.length ? outbox.map((o) => `source_tool_call_id=${o.source_tool_call_id} target=${o.target_member_id}(${agentName(String(o.target_member_id))})`).join(" | ") : "无"}`);
    return { calls, names, handoffs, outbox };
  };

  let hit = null;
  const broken = [];
  let rosterInPrompt = null, noLookup = null;
  // ---- 阶段 A：主路径证明 —— 用户消息【故意不给 id】，模型只能从注入的花名册读（D5-b） ----
  for (let attempt = 1; attempt <= 3 && left() > 130_000 && !hit; attempt += 1) {
    const r = await post(base, h.id,
      `@${arch.name} 必须用 handoff_to 工具把活儿交接给${eng.name}，不要只在正文里 @。`
      + `本次不提供任何 id：toMemberIds 请从平台注入给你的成员名单里取${eng.name}对应的 id。`
      + `不要用 read/bash/ls/grep/find 去翻任何文件或目录来找 id —— 名单就在你的提示词里。`
      + `reason 写“架构已定，交给工程师确认”。workPackage 只写一句：请回一句话确认收到即可，不要写任何文件、不要使用任何工具。${SAY}`);
    const created = r.body.tasks ?? [];
    ev.push(`阶段A（不给 id）尝试 ${attempt}：HTTP ${r.status}；用户建出的 tasks=${created.map((t) => `${t.id.slice(0, 13)}/${agentName(t.memberId)}`).join(",") || "-"}；blocked=${JSON.stringify(r.body.blocked ?? [])}`);
    if (created.length !== 1 || created[0].memberId !== archId) {
      ev.push(`阶段A 尝试 ${attempt} 作废：用户消息自己触发了 ${created.length} 个 Task（必须恰好 1 个且是 ${arch.name}）。`);
      continue;
    }
    await settleRoom(h.id, left());
    const parent = store.getTask(created[0].id);
    const run = readRun(parent, `阶段A 尝试 ${attempt}`);
    rosterInPrompt = /｜id: agent-[0-9a-f-]{36}/.test(parent.prompt);
    const idLines = (parent.prompt.match(/｜id: agent-[0-9a-f-]{36}/g) ?? []).length;
    ev.push(`阶段A D5-b：注入给${arch.name}的 prompt 里「｜id: agent-…」名单行数=${idLines}（修复前恒为 0）→ 花名册带 id=${rosterInPrompt}`);
    const lookups = run.names.filter((n) => LOOKUP.has(n));
    noLookup = lookups.length === 0;
    ev.push(`阶段A D5-b：除 handoff_to 外是否调过查找/读文件类工具=[${lookups.join(", ") || "无"}] → 不需要翻磁盘=${noLookup}`);
    if (!run.handoffs.length) {
      ev.push(`阶段A 尝试 ${attempt}：模型没有调用 handoff_to；原始输出=${clip(modelText(parent.id), 460) || "（空）"}`);
      continue;
    }
    const primary = run.outbox.find((o) => /^call[_-]/.test(String(o.source_tool_call_id)));
    if (!primary) { ev.push(`阶段A 尝试 ${attempt}：调了 handoff_to 但没有真实 toolCallId 的 outbox 行`); continue; }
    const child = (await waitChild(String(primary.child_task_id))) ?? store.getTask(String(primary.child_task_id));
    const dirOk = !!child?.agentDir && child.agentDir === eng.agentDir && child.agentDir !== arch.agentDir;
    const viable = !!child && child.memberId === engId && dirOk && child.status === "succeeded";
    if (viable) { hit = { parent, primary, child, dirOk }; break; }
    broken.push({ phase: "A", srcId: String(primary.source_tool_call_id), child });
    ev.push(`阶段A 尝试 ${attempt}：派发了子 Task 但没以 ${eng.name} 身份跑成 —— status=${child?.status}、member_id=${child?.memberId}、agent_dir=${child?.agentDir ? rel(child.agentDir) : "(空)"}、error=${clip(child?.error, 220)}`);
  }

  // ---- 阶段 B：D5-a —— 让模型只写名字，断言平台把名字解析成真实 agent id ----
  let d5a = null;
  if (left() > 130_000) {
    const r = await post(base, h.id,
      `@${arch.name} 必须用 handoff_to 工具把活儿交接给${eng.name}。`
      + `本次要求你 toMemberIds 里只写成员名字「${eng.name}」，绝对不要写 id。`
      + `reason 写“名字形式交接”。workPackage 只写一句：回一句话确认即可，不要写文件、不要使用任何工具。${SAY}`);
    const created = r.body.tasks ?? [];
    ev.push(`阶段B（要求只写名字）：HTTP ${r.status}；用户建出的 tasks=${created.map((t) => `${t.id.slice(0, 13)}/${agentName(t.memberId)}`).join(",") || "-"}`);
    if (created.length === 1 && created[0].memberId === archId) {
      await settleRoom(h.id, left());
      const parent = store.getTask(created[0].id);
      const run = readRun(parent, "阶段B");
      const primary = run.outbox.find((o) => /^call[_-]/.test(String(o.source_tool_call_id)));
      const child = primary ? ((await waitChild(String(primary.child_task_id))) ?? store.getTask(String(primary.child_task_id))) : null;
      const arg0 = run.handoffs.length ? String(run.handoffs.at(-1).event.args?.toMemberIds?.[0] ?? "") : "";
      const wroteName = arg0 === eng.name;
      const resolvedToId = !!primary && String(primary.target_member_id) === engId;
      d5a = { wroteName, resolvedToId, arg0, child };
      ev.push(`阶段B D5-a：模型写进 toMemberIds 的原文="${arg0 || "(没调用工具)"}"；是否正是名字=${wroteName}`);
      ev.push(`阶段B D5-a：outbox.target_member_id=${primary ? String(primary.target_member_id) : "-"} 是否被解析成 ${eng.name} 的真实 id=${resolvedToId}`);
      if (child) ev.push(`阶段B D5-a：子 Task member_id=${child.memberId} status=${child.status} agent_dir=${child.agentDir ? rel(child.agentDir) : "(空)"} error=${clip(child.error, 200)}`);
      if (!wroteName) ev.push(`阶段B D5-a 未复现：模型没有照要求只写名字（它写了 "${arg0}"），所以这一阶段不构成对名字形式的真实检验，不参与本项判定。`);
    } else {
      ev.push(`阶段B 作废：用户消息触发了 ${created.length} 个 Task`);
    }
  } else {
    ev.push(`阶段B 未跑：单项 ${ITEM_MS / 1000}s 预算不足`);
  }

  dumpTasks(ev, h.id);
  if (broken.length) {
    ev.push(`【派发出去但没跑成的主路径交接】${broken.length} 次：`);
    for (const b of broken) {
      ev.push(`  · 阶段${b.phase} toolCallId=${b.srcId} → child.member_id=${b.child?.memberId} status=${b.child?.status} agent_dir=${b.child?.agentDir ? rel(b.child.agentDir) : "(空)"} error=${clip(b.child?.error, 220)}`);
    }
  }

  // D4 与交接是否成功无关，任何出口都要跑（否则 D4 的结论会随本项结果一起消失）。
  const d4 = await assertD4(base, h, eng, ev, deadline);

  if (!hit) {
    const anyPrimary = outboxHasRealCallId(h.id);
    const parents = roomTasks(h.id).filter((t) => t.memberId === archId);
    const toolNames = [...new Set(parents.flatMap((p) => store.getEvents(p.id, 0, 5000)
      .filter((e) => e.event.type === "tool_execution_start").map((e) => e.event.toolName)))];
    ev.push(`结论口径：${anyPrimary
      ? "handoff_to 确实被真实模型调用、真实 toolCallId 也确实入了 outbox，但没有任何一次让子 Task 以目标 persona 跑成 → FAIL"
      : `模型在 ${parents.length} 次尝试内始终没调用 handoff_to（本会话可用工具见下一行）→ BLOCKED`}`);
    ev.push(`本项里模型调用过的工具：[${toolNames.join(", ") || "无"}]`);
    for (const p of parents) ev.push(`  · 父 ${p.id.slice(0, 13)}（status=${p.status}）原始输出：${clip(modelText(p.id), 600) || "（空）"}`);
    dumpStream(ev, h.id);
    record("3", title, anyPrimary ? "FAIL" : "BLOCKED", ev);
    return;
  }

  const { parent, primary, child } = hit;
  const srcId = String(primary.source_tool_call_id);
  const isRealCallId = /^call[_-]/.test(srcId) && srcId !== `mention:${parent.id}`;
  const squash = (s) => String(s ?? "").replace(/\s+/g, "");
  const parentReplies = [...new Set(msgsOf(h.id, "agent", arch.id).map((m) => m.content))];
  // D6：主路径子 Task 现在也拿到完整群注入 + workPackage 附在最后
  const d6Persona = child.prompt.includes("# 角色：");
  const d6History = child.prompt.includes("# 群聊记录");
  // workPackage 的文字是模型自己写的，不能要求逐字等于我提示里那句；判据是平台把它作为
  // 「# 交接任务说明（来自 <派发者>，平台附在群聊注入之后）」接在群注入之后（buildDispatchPrompt）。
  const d6Work = child.prompt.includes(`# 交接任务说明（来自 ${arch.name}`) && child.prompt.length > 600;
  const d6ParentReply = parentReplies.some((c) => c.length > 8 && squash(child.prompt).includes(squash(c).slice(-40)));
  ev.push(`★ 主路径证据：outbox.source_tool_call_id=${srcId}`);
  ev.push(`  · 是运行时真实 toolCallId（^call_…），不是次路径合成的 mention:<taskId> → ${isRealCallId}`);
  ev.push(`  · outbox 全行：id=${primary.id} source_attempt_id=${String(primary.source_attempt_id).slice(0, 13)} target=${primary.target_member_id}(${agentName(String(primary.target_member_id))}) reason=${clip(primary.reason, 120)} status=${primary.status}`);
  ev.push(`  · 子 Task：${taskLine(child)} depth=${child.depth}（父 depth=${parent.depth}）`);
  ev.push(`  · 人格断言：child.agent_dir=${rel(child.agentDir)} == ${eng.name} 自己的 agentDir（${rel(eng.agentDir)}）且 != 父 agent ${arch.name} 的 ${rel(arch.agentDir)} → ${hit.dirOk}`);
  ev.push(`  · 执行断言：child.status=${child.status}；attempts=${store.getAttempts(child.id).map((a) => `#${a.sequence}/${a.status}`).join(",")}`);
  ev.push(`  · 子 agent 进群回复：${clip(msgsOf(h.id, "agent", child.memberId).at(-1)?.content, 300) || "（无）"}`);
  ev.push(`D6 断言（子 Task 看到完整群上下文，不是裸 workPackage）：含「# 角色：」=${d6Persona}；含「# 群聊记录」=${d6History}；含父这条回复原文=${d6ParentReply}；末尾附 workPackage（「# 交接任务说明」）=${d6Work}`);
  const histIdx = child.prompt.indexOf("# 群聊记录");
  ev.push(`  · 子 Task prompt 从「# 群聊记录」起的片段：${histIdx < 0 ? "(无此段)" : clip(child.prompt.slice(histIdx, histIdx + 460), 460)}`);
  ev.push(`  · 子 Task prompt 末尾 260 字：${clip(child.prompt.slice(-260), 260)}`);

  const d5aOk = d5a === null || !d5a.wroteName ? null : (d5a.resolvedToId && d5a.child?.status === "succeeded");
  if (d5aOk === false) ev.push(`D5-a 断言失败：模型按要求只写了名字，但平台没有把它解析成真实 id / 子 Task 没跑成（见上面阶段B 行）。`);
  const ok = isRealCallId && hit.dirOk && child.status === "succeeded" && d4
    && rosterInPrompt === true && noLookup === true
    && d6Persona && d6History && d6Work && d6ParentReply
    && d5aOk !== false;
  dumpStream(ev, h.id);
  record("3", title, ok ? "PASS" : "FAIL", [...ev,
    `断言：主路径真实 toolCallId=${isRealCallId}；目标 persona 跑成=${hit.dirOk && child.status === "succeeded"}；`
    + `D5-b 花名册带 id=${rosterInPrompt} 且不翻磁盘=${noLookup}；D6 群上下文=${d6Persona && d6History && d6ParentReply}+workPackage=${d6Work}；`
    + `D5-a 名字形式解析=${d5aOk === null ? "未复现（模型没只写名字）" : d5aOk}；D4 无噪音=${d4}`]);
}

/** 本群任意父 Task 的 outbox 里是否出现过真实 toolCallId（用来区分 FAIL 与 BLOCKED）。 */
const outboxHasRealCallId = (roomId) => roomTasks(roomId).some((t) =>
  store.getOutbox(t.id).some((o) => /^call[_-]/.test(String(o.source_tool_call_id))));

/**
 * D4：正文里的代码记号（@ts-ignore / @types/node / @media）不该被当成"群里没这个成员"。
 * 只数由这些记号引起的【提及解析】噪音，别的未解析名字（例如模型自己写的 @用户）不计。
 */
async function assertD4(base, h, eng, ev, deadline) {
  const left = () => Math.max(1000, deadline - Date.now());
  // a) 用户路径（确定性，不赌模型）：真实提及 + 代码记号必须 201，不能因 @ts-ignore 被拒。
  const codeMsg = `@${eng.name} 只回复一行，内容原样写成：先给 @ts-ignore 和 @types/node 这两处加豁免，@media 断点保持不动。不要用任何工具。${SAY}`;
  const d4a = await post(base, h.id, codeMsg);
  const d4aOk = d4a.status === 201;
  ev.push(`【D4a】含 @ts-ignore / @types/node / @media 且带一个真实提及的用户消息 → HTTP ${d4a.status}`
    + `（必须 201；实际 code=${d4a.body.code ?? "-"}，tasks=${(d4a.body.tasks ?? []).length} 个）`);
  // b) 反证（防止修复过头）：整条消息只有一个真不存在的提及时，必须仍是 400/UNKNOWN_MENTION。
  //    注意不能混着真实提及写 —— 有任一可解析目标时平台按设计 201（未知的那个忽略）。
  const d4b = await post(base, h.id, `@根本不存在的人名 单独看下这个需求。`);
  const d4bOk = d4b.status === 400 && d4b.body.code === "UNKNOWN_MENTION";
  ev.push(`【D4b 反证】只含真·未知提及的消息 → HTTP ${d4b.status} code=${d4b.body.code ?? "-"} names=${JSON.stringify(d4b.body.names ?? [])}`
    + `（必须 400/UNKNOWN_MENTION，否则修复过头把未知提及检测关掉了：${d4bOk}）`);

  // c) agent 正文路径：这一条依赖模型是否照抄，只作补充证据，不作为唯一判据。
  const before = new Set(rooms.listMessages(h.id).filter((m) => m.authorKind === "system").map((m) => m.id));
  await settleRoom(h.id, left());
  const reply = msgsOf(h.id, "agent", eng.id).at(-1);
  const carried = !!reply && /@ts-ignore|@types|@media/.test(reply.content);
  // D5-a 之后主路径的拒绝换了标签【交接校验】，所以噪音必须同时看两种标签，
  // 否则代码记号只是换了个标签冒出来，也会被当成"修好了"。
  const fresh = rooms.listMessages(h.id)
    .filter((m) => m.authorKind === "system" && !before.has(m.id)
      && (m.content.includes("【提及解析】") || m.content.includes("【交接校验】")));
  const codeNoise = fresh.filter((m) => ["@ts-ignore", "@types", "@media"].some((t) => m.content.includes(t)));
  ev.push(`【D4c】${eng.name} 真实回复：${clip(reply?.content, 220) || "（无）"}｜回复里确实带着代码记号=${carried}`);
  ev.push(`【D4c】本轮新增【提及解析】/【交接校验】系统消息 ${fresh.length} 条，其中由代码记号引起 ${codeNoise.length} 条（必须 0）`);
  if (codeNoise.length) ev.push(`【D4c】噪音原文：${codeNoise.map((m) => clip(m.content, 200)).join(" | ")}`);
  return d4aOk && d4bOk && codeNoise.length === 0;
}
// ===== 4. A→B→A 循环被阻断 ================================================
async function item4(base) {
  const ev = [];
  const title = "人为制造 A→B→A，循环被阻断（真实模型）";
  const deadline = Date.now() + ITEM_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const h = await importRoom(base, "i10-item4");
  if (h.error) return failFast("4", title, `导入失败：${h.error}`);
  const a = byRole(h, "架构师"), b = byRole(h, "工程师");
  if (!a || !b) return failFast("4", title, `缺 架构师/工程师：${h.agents.map((x) => x.role).join(",")}`);
  store.db.prepare("UPDATE chat_rooms SET rules = rules || ? WHERE id = ?").run(
    `\n\n## 流程乒乓测试规则（人为制造回边）\n- 你是${a.name}时：每次发言必须在你要发到群里的那句话里 @${b.name} 一次，只说一句话。\n`
    + `- 你是${b.name}时：收到 ${a.name} 的 @ 后，必须在你要发到群里的那句话里立刻回 @${a.name} 一次，只说一句话，不要再 @ 别人。\n`
    + `- 所有人：summary 会被原样发回群里，所以 @ 必须写在 summary 里；不许使用工具，不许写文件。\n`, h.id);
  ev.push(`A=${a.name}（${a.role}）、B=${b.name}（${b.role}）；chat_rooms.max_rounds=${rooms.getRoom(h.id).maxRounds}`);
  ev.push(`乒乓规则已写进 chat_rooms.rules（会以「# 群规则」注入每次触发的 prompt）`);

  const r1 = await post(base, h.id, `@${a.name} 请按群里的「流程乒乓测试规则」开始，只说一句话。${SAY}`);
  ev.push(`turn1 HTTP ${r1.status} tasks=${(r1.body.tasks ?? []).map((t) => t.id.slice(0, 13)).join(",") || "-"} blocked=${JSON.stringify(r1.body.blocked ?? [])}`);
  await settleRoom(h.id, left());
  let loop = sysMsgs(h.id, "【流程守卫·循环】");
  let backEdge = !!msgsOf(h.id, "agent", b.id).at(-1)?.content.includes(`@${a.name}`);
  ev.push(`第一轮：回边=${backEdge}，循环系统消息=${loop.length} 条`);

  if (!backEdge && loop.length === 0 && Date.now() + 120_000 < deadline) {
    ev.push(`模型没形成回边，再试一次（用户消息会按 AC4.2/AC5.3 重置本轮，这是设计行为）。`);
    const r2 = await post(base, h.id,
      `@${a.name} 严格按「流程乒乓测试规则」再来一轮：你这句话里必须 @${b.name}，${b.name} 收到后必须回 @${a.name}。每人只说一句话。${SAY}`);
    ev.push(`turn2 HTTP ${r2.status}`);
    await settleRoom(h.id, left());
    loop = sysMsgs(h.id, "【流程守卫·循环】");
    backEdge = !!msgsOf(h.id, "agent", b.id).at(-1)?.content.includes(`@${a.name}`);
    ev.push(`第二轮：回边=${backEdge}，循环系统消息=${loop.length} 条`);
  }

  dumpTasks(ev, h.id);
  dumpStream(ev, h.id);
  const st = rooms.getState(h.id);
  // 只看最后一个用户轮次（用户消息与其 Task 同一个 now 写入），否则两次尝试会累加计数。
  const lastUser = rooms.listMessages(h.id).filter((m) => m.authorKind === "user").at(-1);
  const turn = roomTasks(h.id).filter((t) => t.createdAt >= lastUser.createdAt);
  const turnMsgs = rooms.listMessages(h.id).filter((m) => m.seq >= lastUser.seq);
  const aTriggers = turn.filter((t) => t.memberId === a.id).length;
  const dupInChain = new Set(st.chain).size !== st.chain.length;
  const bMsg = turnMsgs.filter((m) => m.authorKind === "agent" && m.authorAgentId === b.id).at(-1);
  backEdge = !!bMsg && bMsg.content.includes(`@${a.name}`);
  const bTask = turn.filter((t) => t.memberId === b.id).at(-1);
  ev.push(`最后一个用户轮次起点：msg seq=${lastUser.seq} created_at=${new Date(lastUser.createdAt).toISOString()}；该轮 Task 数=${turn.length}`);
  ev.push(`room_state：chain=${JSON.stringify(st.chain)}（${st.chain.map(agentName).join(" → ")}）round_count=${st.roundCount} terminated=${st.terminated}`);
  ev.push(`【流程守卫·循环】系统消息：${loop.map((m) => `[seq ${m.seq}] ${clip(m.content, 260)}`).join(" | ") || "（无）"}`);
  ev.push(`chain 中是否有重复 id：${dupInChain}`);
  ev.push(`本轮 ${a.name} 被建了几个 Task：${aTriggers}（第二次触发不得产生 Task → 必须恰为 1）`);
  ev.push(`本轮 ${b.name} 进群原文（回边是否成立）：${clip(bMsg?.content, 300) || `（本轮 ${b.name} 没发言）`}`);

  if (!backEdge) {
    // 归因必须先分诊，不能直接写成「模型不肯形成回边」。实测：某次运行里 B 的 Task 是
    // `status=failed attempts=3` —— 回边根本没机会发生，那是**运行失败**，不是模型不配合。
    // 把前者写成后者正是 Q44/§9.9 记过的错（provider 无事件超时曾被记成「模型不肯收尾」）。
    const why = triageUnobserved(bTask?.id, { hasReply: !!bMsg });
    ev.push(`回边未成立的原因（对 ${b.name} 的 Task ${bTask?.id?.slice(0, 13) ?? "无"} 分诊）：${why.kind} —— ${why.why}`);
    if (loop.length > 0 && !dupInChain && aTriggers === 1) {
      ev.push(`注意：本轮确实落了一条 LOOP 阻断，但它是 ${a.name} 在自己那句话里同时 @ 了 ${b.name} 和 `
        + `@${a.name}（A→A 一跳）被拒，不是 AC4.1 要求的 ${a.name}→${b.name}→${a.name} 回边形状。`);
    }
    ev.push(`结论：本项在真实模型下没有跑通（AC4.1 要求的 A→B→A 回边未发生）。`);
    ev.push(`A→B→A 的阻断目前只有 mock 级证明（packages/orchestrator/src/room-guards.test.ts 的 AC4.1 用例）；本报告不把它算作真实模型通过。`);
    record("4", title, "BLOCKED", ev);
  } else {
    const ok = loop.length > 0 && !dupInChain && aTriggers === 1;
    if (!ok) ev.push(`回边已成立但守卫观察结果与断言不符：见上面的 chain 与 Task 计数。`);
    record("4", title, ok ? "PASS" : "FAIL", ev);
  }
}

// ===== 5. 轮次上限 → 协调者强制收尾 =======================================
async function item5(base) {
  const ev = [];
  const title = "达到轮次上限 → Coordinator 强制收尾（收尾不计轮次）+ terminated 后阻断";
  let deadline = Date.now() + ITEM_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const h = await importRoom(base, "i10-item5");
  if (h.error) return failFast("5", title, `导入失败：${h.error}`);
  const pm = byRole(h, "产品经理"), qa = byRole(h, "QA工程师");
  const coord = h.agents.find((x) => x.isCoordinator);
  if (!pm || !qa || !coord) return failFast("5", title, `缺 产品经理/QA/协调者：${h.agents.map((x) => `${x.name}/${x.role}/coord=${x.isCoordinator}`).join(",")}`);
  // AC5.4 的配置入口现在存在，就走真实端点，不再直接改库：这一项同时充当
  // 「上限可按 ChatRoom 配置」的验收证据，而不只是「按群读 max_rounds」的证据。
  const capSet = await fetch(`${base}/api/rooms/${h.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxRounds: 1 }),
  });
  const capSetBody = await capSet.json().catch(() => ({}));
  ev.push(`群=${h.id}；AC5.4 按群配置：PATCH /api/rooms/${h.id} {maxRounds:1} → HTTP ${capSet.status}，读回 room.maxRounds=${rooms.getRoom(h.id).maxRounds}`);
  if (capSet.status !== 200 || capSetBody.maxRounds !== 1) {
    return failFast("5", title, `AC5.4 配置失败：HTTP ${capSet.status} ${JSON.stringify(capSetBody).slice(0, 160)}`);
  }
  ev.push(`被触发者=${pm.name}；协调者=${coord.name}（${coord.role}）；终止探针=${qa.name}`);

  // 顺便在真实 HTTP 路径上再证一次 D2：用角色名 @产品经理 触发（不是人名）。
  const r = await post(base, h.id, `@产品经理 用一句话给这个需求定个验收口径。不要使用任何工具。`);
  ev.push(`turn1 HTTP ${r.status} tasks=${(r.body.tasks ?? []).map((t) => t.id.slice(0, 13)).join(",") || "-"} blocked=${JSON.stringify(r.body.blocked ?? [])}`);
  const cap = sysMsgs(h.id, "【流程守卫·轮次上限】");
  ev.push(`轮次上限系统消息（与本轮 Task 同一事务写入）：${cap.map((m) => `[seq ${m.seq}] ${clip(m.content, 280)}`).join(" | ") || "（无）"}`);
  const wrapRows = store.listTasks(2000).filter((t) => (t.idempotencyKey ?? "").startsWith(`wrapup:${h.id}`));
  ev.push(`协调者收尾 Task：${wrapRows.map((t) => `${taskLine(t)} status=${t.status}`).join(" | ") || "（无）"}`);
  ev.push(`收尾 Task 的 prompt 尾部（平台强制指令，逐字）：${clip((wrapRows[0]?.prompt ?? "").slice(-400), 400)}`);
  const roundsAtCap = rooms.getState(h.id).roundCount;
  ev.push(`触发后 room_state.round_count=${roundsAtCap}（产品经理那一轮，1/1 顶到上限）`);

  // 收尾 Task 可能撞无事件超时（provider 挂起；stall watchdog 的 120s 是刻意设计）。
  // 平台的自动重试正是为这种情况准备的，所以判定之前要先给它重试的机会：上一次跑
  // 就栽在这里——预算已被前面的触发吃掉，收尾 Task 还停在 retry_wait 就被读成
  // "没跑成"，把一次仍在重试的运行当成了结论。
  deadline = Math.max(deadline, Date.now() + 300_000);
  await settleRoom(h.id, left());
  const state1 = rooms.getState(h.id);
  const wrap = wrapRows[0] ? store.getTask(wrapRows[0].id) : null;
  const coordMsg = msgsOf(h.id, "agent", coord.id).at(-1);
  dumpTasks(ev, h.id);
  // 收尾 Task 没跑成时必须说清为什么：模型原始输出、每次 Attempt 的错误、真实工具调用。
  if (wrap && wrap.status !== "succeeded") {
    ev.push(`收尾 Task 诊断：status=${wrap.status} attempts=${wrap.batchAttempts} error=${clip(wrap.error, 260)}`);
    for (const a of store.getAttempts(wrap.id)) ev.push(`  · Attempt#${a.sequence} status=${a.status} fence=${a.fencingToken} error=${clip(a.error, 200)}`);
    ev.push(`  · 模型真实工具调用：${toolCallsOf(wrap.id).length ? toolCallsOf(wrap.id).join(" ; ") : "（无）"}`);
    ev.push(`  · 模型原始输出（room_messages/tasks.error/events 任一处）：${clip(modelText(wrap.id), 700) || "（空）"}`);
    const usage = store.getUsage(wrap.id);
    ev.push(`  · 该 Task 的 usage：${usage.length ? usage.map((u) => `${u.provider}/${u.model} tokens=${u.totalTokens}`).join(" | ") : "（无 usage 行）"}`);
  }
  ev.push(`协调者真实收尾原文（room_messages.author=${coord.name}）：${clip(coordMsg?.content, 400) || "（无回复）"}`);
  ev.push(`Q40 语义验证（收尾 Task 不占轮次）：收尾前 round_count=${roundsAtCap} → 协调者跑完后 round_count=${state1.roundCount}`);
  const wrapNotCharged = state1.roundCount === roundsAtCap;
  const ended = !!coordMsg && coordMsg.content.includes("[讨论结束]");
  const termSys = sysMsgs(h.id, "【流程守卫·终止】");
  ev.push(`终止系统消息：${termSys.map((m) => `[seq ${m.seq}] ${clip(m.content, 260)}`).join(" | ") || "（无）"}`);

  const recheck = new RoomStore(DB); // AC6.4：terminated 落盘，新连接读同一文件
  const persisted = recheck.getState(h.id);
  recheck.close();
  ev.push(`新 RoomStore 句柄重读 room_state：terminated=${persisted.terminated} round_count=${persisted.roundCount} chain=${JSON.stringify(persisted.chain)}`);

  // 真实阻断探针：播一个仍在飞的 agent Task（等价于 terminate 之前已排队的交接），
  // 它的回复要求 @ 别人 → worker 的 planRoomGuards 应按 TERMINATED 拒绝。
  let probe = "探针未跑";
  let blockedOk = false;
  // mainLeak = 群已终止却仍建出了新 Task，那是守卫真的漏了（FAIL）。
  // 其余"没观察到"一律是构造/基础设施/模型不配合，报 BLOCKED，不算守卫失败。
  let mainLeak = false;
  let mainReason = "";
  if (!persisted.terminated) {
    if (wrap && hungWithoutEvents(wrap.id)) {
      mainReason = "收尾 Task 的 Attempt 撞了无事件超时（provider 挂起），群从未终止，探针无从验证阻断";
    } else if (wrap && wrap.status !== "succeeded") {
      mainReason = `收尾 Task 未跑成（status=${wrap.status}），群从未终止，探针无从验证阻断`;
    } else {
      mainReason = "room 未进入 terminated（协调者没输出 [讨论结束]），无从验证阻断";
    }
    probe = `BLOCKED：${mainReason}`;
  } else if (Date.now() + 90_000 > deadline) {
    probe = `单项 ${ITEM_MS / 1000}s 预算不足，探针未跑`;
    mainReason = `单项 ${ITEM_MS / 1000}s 预算不足，阻断探针未跑`;
  } else {
    for (let tryNo = 1; tryNo <= 2 && !blockedOk; tryNo += 1) {
      if (Date.now() + 90_000 > deadline) {
        probe = `时间预算不足，探针第 ${tryNo} 次未跑`;
        mainReason = `时间预算不足，探针第 ${tryNo} 次未跑`;
        break;
      }
      const hist = rooms.listMessages(h.id);
      const prompt = `${buildRoomPrompt(rooms.getRoom(h.id), qa, rooms.listAgents(h.id), hist)}`
        + `\n\n平台补充：请把下面这句话原样作为你的 summary 输出，一个字都别改，也不要使用任何工具：\n已记录，请 @${pm.name} 复核。${SAY}`;
      const seeded = store.createTask({
        tenantId: "i10", projectId: "i10-item5", memberId: qa.id, workspacePath: WS,
        agentDir: qa.agentDir, prompt, groupId: h.id, model: MODEL,
        idempotencyKey: `i10-5-probe:${h.id}:${hex(4)}`,
      });
      ev.push(`探针 ${tryNo}：播入在飞 Task（模拟终止前已排队的交接）${taskLine(seeded)}`);
      const pmBefore = roomTasks(h.id).filter((t) => t.memberId === pm.id).length;
      deadline = Math.max(deadline, Date.now() + 90_000);
      await settleRoom(h.id, left());
      const termBlocks = sysMsgs(h.id, "【流程守卫·已终止】");
      const pmAfter = roomTasks(h.id).filter((t) => t.memberId === pm.id).length;
      const qaTask = roomTasks(h.id).find((t) => t.id === seeded.id);
      ev.push(`探针 ${tryNo}：${qa.name} 进群原文=${clip(msgsOf(h.id, "agent", qa.id).at(-1)?.content, 300) || "（无）"}；task.status=${qaTask?.status}`);
      ev.push(`探针 ${tryNo}：已终止系统消息=${termBlocks.map((m) => `[seq ${m.seq}] ${clip(m.content, 260)}`).join(" | ") || "（无）"}`);
      ev.push(`探针 ${tryNo}：${pm.name} 的 Task 数 ${pmBefore} → ${pmAfter}（新触发被阻断则不变）`);
      // 已经终止的群仍然建出了新 Task = 守卫漏放，这是唯一算 FAIL 的形状；
      // 其余"没观察到"（超时、预算、模型没 @ 人）都是 BLOCKED。
      mainLeak = pmAfter > pmBefore;
      blockedOk = termBlocks.length > 0 && pmAfter === pmBefore;
      if (blockedOk) {
        probe = `真实 worker 在 terminated 之后拒绝了 ${qa.name} 发起的触发（探针 ${tryNo}）`;
      } else if (mainLeak) {
        probe = `探针 ${tryNo}：群已 terminated，${pm.name} 仍拿到 ${pmAfter - pmBefore} 个新 Task → 守卫漏放`;
        mainReason = probe;
      } else {
        const qaHung = qaTask && hungWithoutEvents(qaTask.id);
        probe = `探针 ${tryNo} 未观察到阻断（${qaHung ? "该任务撞了无事件超时，触发没机会发生"
          : `task.status=${qaTask?.status ?? "未知"}，见上面原文/计数`}）`;
        mainReason = probe;
      }
    }
  }

  dumpStream(ev, h.id);
  ev.push(`探针结论：${probe}`);
  // ===== AC5.2 单独验证：ROUND_CAP 的真实拒绝 =====
  // 上面那跑观察到的是【流程守卫·已终止】，不是 ROUND_CAP：maxRounds=1 时收尾不占轮次、
  // 协调者随即输出 [讨论结束] 把群置为 terminated，而判定顺序 terminated 优先，超限拒绝
  // 永远轮不到。要看到 ROUND_CAP，必须**消除竞态**：把群设成「无协调者」
  // （coordinator_agent_id = NULL），于是 queueWrapUpTask 只落一条「无法强制收尾」的系统
  // 消息、terminated 永远不会变真，第 2 次触发必然撞上 ROUND_CAP。
  // 这同时验证了 Q40 记录的无协调者回退路径。
  //
  // 判定顺序是 terminated → LOOP → ROUND_CAP（room-guards.ts:39-40），所以「第 2 次触发」
  // 的目标还必须落在链外，否则先撞 LOOP。
  //
  // 探针的前置条件是**模型按指令在 summary 里 @ 到那个链外目标**，这一环由模型决定；
  // 另一条会产出同样"静悄悄"结果的前置条件是**预算**。两者必须分开：
  //   · 任务停在 queued  → worker 没拿到执行时间（预算被主探针耗尽），与守卫无关；
  //   · 任务成功但没 @ 人 → 模型改写了指令，构造没搭起来。
  // 早先我把一次失败写成"约 1/13 次模型不 @ 人"，那是归因错误：那次两个群的任务
  // 同时是 queued，真实原因是单项硬上限已被主探针吃掉，`left()` 落到 1000ms 下限。
  // 现在每次尝试前按主探针同一约定抬预算，并对 queued 单独报"预算耗尽"。
  // 失败时仍换一个全新群重试一次，并把每次的原文与计数都留下：重试只消除构造噪声，
  // 断言本身一个字没放松（两个群都没观察到 -> 仍是 FAIL）。
  const runCapProbe = async (attemptNo) => {
    const room = await importRoom(base, `i10-item5-cap${attemptNo > 1 ? `-r${attemptNo}` : ""}`);
    if (room.error) return { kind: "BLOCKED", why: `建群失败：${room.error}` };
    const pm = byRole(room, "产品经理"), eng = byRole(room, "工程师");
    if (!pm || !eng) return { kind: "BLOCKED", why: "缺 产品经理/工程师，无法构造" };
    const qa = byRole(room, "QA工程师");
    const coord = room.agents.find((x) => x.isCoordinator);
    if (!qa || !coord) return { kind: "BLOCKED", why: "缺 QA/协调者，无法构造第 2 次触发" };

    // 这里仍是直接写库，而不是用上面的 PATCH：端点刻意只暴露 maxRounds。
    // 改协调者会把守卫判定所依赖的身份移走，属于另一件事，不该为了一条探针顺手开洞。
    store.db.prepare("UPDATE chat_rooms SET max_rounds = 1, coordinator_agent_id = NULL WHERE id = ?").run(room.id);
    const row = rooms.getRoom(room.id);
    ev.push(`AC5.2[${attemptNo}] 专用群=${room.id} maxRounds=${row.maxRounds} coordinatorAgentId=${row.coordinatorAgentId}（无协调者 → 不会 terminated，窗口稳定）`);

    // 第 1 轮：用户 @工程师（链外）→ 工程师进链，round 1/1，调度收尾但因无协调者只落消息。
    // 每次尝试都要先把预算抬到"还够跑一轮"，否则主探针耗尽单项硬上限后，`left()`
    // 会落在 1000ms 下限，settleRoom 立刻返回，两个群同时留下 status=queued 的任务，
    // 看起来像守卫没生效 —— 那是探针被饿死，不是守卫被绕过。上与主探针同一约定。
    deadline = Math.max(deadline, Date.now() + 120_000);
    const t1 = await post(base, room.id, `@${eng.name} 一句话说明本轮只占一格。不要使用任何工具。`);
    ev.push(`AC5.2[${attemptNo}] turn1 HTTP ${t1.status}（@${eng.name}，链外目标）`);
    await settleRoom(room.id, left());
    const st1 = rooms.getState(room.id);
    const noCoord = rooms.listMessages(room.id).filter(
      (m) => m.authorKind === "system" && m.content.includes("无法强制收尾"),
    );
    ev.push(`AC5.2[${attemptNo}] 无协调者回退消息：${noCoord.map((m) => `[seq ${m.seq}] ${clip(m.content, 220)}`).join(" | ") || "（无）"}`);
    ev.push(`AC5.2[${attemptNo}] 第1轮后：round_count=${st1.roundCount}/${row.maxRounds} terminated=${st1.terminated} chainLen=${st1.chain.length}`);

    // 第 2 次触发：注入一条 QA 任务，其回复 @协调者（链外）→ 目标不在链内，于是命中 ROUND_CAP。
    const qaTask = store.createTask({
      tenantId: "i10", projectId: `i10-item5-cap${attemptNo}`, memberId: qa.id, workspacePath: WS,
      agentDir: qa.agentDir,
      prompt: buildRoomPrompt(rooms.getRoom(room.id), qa, rooms.listAgents(room.id), rooms.listMessages(room.id))
        + `\n\n平台补充：请把下面这句话原样作为你的 summary 输出，一个字都别改，也不要使用任何工具：\n已记录，请 @${coord.name} 复核。${SAY}`,
      groupId: room.id, model: MODEL,
      idempotencyKey: `i10-5-cap:${room.id}:${hex(4)}`,
    });
    ev.push(`AC5.2[${attemptNo}] 播入 ${qa.name} 任务 ${taskLine(qaTask)}（其回复 @${coord.name}＝链外目标，即为第 2 次触发）`);
    deadline = Math.max(deadline, Date.now() + 120_000);
    await settleRoom(room.id, left());

    const qaAfter = store.getTask(qaTask.id);
    ev.push(`AC5.2[${attemptNo}] ${qa.name} 任务终态：status=${qaAfter?.status} error=${clip(qaAfter?.error, 200)} 回复=${clip(msgsOf(room.id, "agent", qa.id).at(-1)?.content, 200) || "（无）"}`);
    const st2 = rooms.getState(room.id);
    const capMsgs = rooms.listMessages(room.id).filter(
      (m) => m.authorKind === "system" && m.content.startsWith("【流程守卫·轮次上限】")
        && m.content.includes("不再处理新的 agent 触发"),
    );
    const coordTasks = roomTasks(room.id).filter((t) => t.memberId === coord.id).length;
    ev.push(`AC5.2[${attemptNo}] 第2次触发后：round_count=${st2.roundCount}/${row.maxRounds} terminated=${st2.terminated}`);
    ev.push(`AC5.2[${attemptNo}] ROUND_CAP 拒绝消息（必须含「不再处理新的 agent 触发」）：${capMsgs.map((m) => `[seq ${m.seq}] ${clip(m.content, 240)}`).join(" | ") || "（无）"}`);
    ev.push(`AC5.2[${attemptNo}] 专用群全流=${rooms.listMessages(room.id).map((m) => `[${m.seq}]${m.authorKind}:${clip(m.content, 70)}`).join(" | ")}`);
    ev.push(`AC5.2[${attemptNo}] 目标 ${coord.name} 的 Task 数=${coordTasks}（被 ROUND_CAP 拒绝则必须为 0）`);
    const ok = capMsgs.length > 0 && coordTasks === 0 && !st2.terminated;
    if (ok) return { kind: "OK", why: "" };

    // 「没观察到」有四类成因，对结论的意义完全不同，必须分开报 —— 把它们混成一句
    // "未命中 ROUND_CAP"，已经让文档里写过两次错误的归因。
    //   leak    上限已满却仍建出目标 Task → 守卫真的漏了，只有这一类是 FAIL
    //   hung    provider 无事件超时 / 串行 worker 被在飞 Task 占住 → 与守卫无关
    //   starved 本群任务停在 queued 而 worker 空闲 → 预算或领取问题
    //   silent  任务成功但回复里没有指向链外目标的 @ → 模型不配合
    const hungTask = (t) => t ? hungWithoutEvents(t.id) : false;
    const inFlight = store.listTasks(2000).filter((t) => t.status === "running");
    const pending = roomTasks(room.id).filter((t) =>
      t.status !== "succeeded" && t.status !== "failed" && t.status !== "cancelled").length;
    if (coordTasks > 0 && !st2.terminated) {
      return { kind: "FAIL", why: `轮次已满仍未被拒绝：目标 ${coord.name} 拿到了 ${coordTasks} 个 Task` };
    }
    if (st2.terminated) return { kind: "BLOCKED", why: "群被终止（terminated），判定顺序轮不到 ROUND_CAP" };
    if (qaAfter && hungTask(qaAfter)) {
      return { kind: "BLOCKED", why: "本任务撞了无事件超时（provider 挂起），第 2 次触发没机会发生" };
    }
    if (inFlight.length > 0) {
      return {
        kind: "BLOCKED",
        why: `worker 被 ${inFlight.length} 个在飞 Task 占住（队列串行，一次只跑一个），`
          + `其中 ${inFlight.filter(hungTask).length} 个已撞无事件超时；本群 ${pending} 个 Task 没被领取 —— 与守卫无关`,
      };
    }
    if (pending > 0) {
      return { kind: "BLOCKED", why: `本群仍有 ${pending} 个 Task 停在 queued 而 worker 空闲：预算/领取问题` };
    }
    return {
      kind: "BLOCKED",
      why: `未命中 ROUND_CAP：${qaAfter?.status !== "succeeded" ? `任务未成功（${qaAfter?.status}）` : "回复里没有指向链外目标的 @ 触发"}`,
    };
  };

  let capProbe = "未跑";
  let capBlocked = false;
  let capLeak = false;
  let capReason = "";
  // 预算由 runCapProbe 内部在每次 settle 前发放；这里不再重复抬一次，
  // 否则一次尝试会拿到三段预算，第 5 项的最坏耗时就失去上界了。
  for (let attempt = 1; attempt <= 2 && !capBlocked; attempt += 1) {
    const r = await runCapProbe(attempt);
    capBlocked = r.kind === "OK";
    capLeak = r.kind === "FAIL";
    capReason = r.why;
    ev.push(`AC5.2[${attempt}] 结论：${capBlocked ? "命中 ROUND_CAP" : `${r.kind} —— ${r.why}`}`);
    capProbe = capBlocked
      ? `真实 worker 在 round_count 达上限且未终止时、对链外目标按 ROUND_CAP 拒绝了新触发（第 ${attempt} 个群）`
      : `未观察到 ROUND_CAP 拒绝（第 ${attempt} 个群：${r.why}）`;
  }
  ev.push(`AC5.2 探针结论：${capProbe}`);

  // 判定分层：守卫真的漏放（leak）才是 FAIL；provider 挂起、预算耗尽、模型不肯
  // 按指令输出，都报 BLOCKED 并留下原因 —— 把基础设施故障写成"守卫不稳定"，
  // 已经让我在文档里错过两次正确的归因。
  // 与重构前的 `ok` 逐条款等价，一个断言没少：cap/wrap 成功/不占轮次/ended/持久化
  // terminated/主探针阻断/AC5.2 命中。只是把"全都不满足"换成"分诊"——
  // leak（守卫漏放）才是 FAIL，其余未观察到报 BLOCKED 并给出具名原因。
  const guardsHeld = cap.length > 0 && !!wrap && wrap.status === "succeeded"
    && wrapNotCharged && persisted.terminated && ended;
  const leak = mainLeak || capLeak;
  const wrapHung = wrap ? hungWithoutEvents(wrap.id) : false;
  let verdict = "FAIL";
  if (leak) verdict = "FAIL";
  else if (blockedOk && capBlocked && !guardsHeld) {
    verdict = "BLOCKED";
    ev.push(`本项被 BLOCKED 的原因：${wrapHung ? "协调者收尾 Task 撞了无事件超时（provider 挂起）"
      : mainReason || capReason || "收尾/终止证据不齐，但没有任何一处守卫漏放"}`);
  } else if (!blockedOk || !capBlocked) {
    verdict = "BLOCKED";
    ev.push(`本项被 BLOCKED 的原因：${mainReason || capReason}`);
  }
  if (wrapHung) ev.push(`注意：收尾 Task 的 Attempt 里出现过 no-events 超时 —— 这是挂起，不是模型不肯收尾`);
  record("5", title, capBlocked && blockedOk && guardsHeld ? "PASS" : verdict, ev);
}

// ===== 6. 杀 Worker 重启，无重复计费 ======================================
async function item6(base, main) {
  const ev = [];
  const title = "杀掉 Worker 进程后重启：未完成 Task 继续执行，无重复计费";
  const deadline = Date.now() + ITEM_MS;
  const left = () => Math.max(1000, deadline - Date.now());
  const h = await importRoom(base, "i10-item6");
  if (h.error) return failFast("6", title, `导入失败：${h.error}`);
  const pm = byRole(h, "产品经理");
  if (!pm) return failFast("6", title, `缺产品经理：${h.agents.map((x) => x.role).join(",")}`);
  store.db.prepare("UPDATE chat_rooms SET rules = rules || ? WHERE id = ?").run(
    "\n\n## 崩溃恢复测试规则\n- 被 @ 的成员必须先用写文件工具在工作区依次创建 crash/1.md … crash/3.md 共 3 个文件，"
    + "每个文件写两三句关于「需求拆解」的要点，全部写完（3 个都写完）之后才在 summary 里汇总这 3 个文件路径，并用 outcome=success。\n", h.id);
  ev.push(`群=${h.id}；任务设计：让 ${pm.name} 真实调用写文件工具 3 次（persona cwd=${rel(pm.agentDir)}），制造可杀的长任务窗口`);

  const r = await post(base, h.id,
    `@${pm.name} 严格按群里的「崩溃恢复测试规则」执行：依次创建 3 个文件 crash/1.md、crash/2.md、crash/3.md，`
    + `每个文件写两三句要点，三个文件全部写完后才在 summary 里汇总它们的路径。请一个一个来，不要跳过写文件，`
    + `也不要在文件还没写完时就宣布完成。`);
  const taskId = r.body.tasks?.[0]?.id ?? null;
  ev.push(`HTTP ${r.status}；目标任务=${taskId}`);
  if (!taskId) return failFast("6", title, `trigger 没建出 Task：${clip(JSON.stringify(r.body), 200)}`);

  // worker#1 = 前面几项一直在用的那个真进程 worker。
  const w1 = main;
  const claimed = await waitFor(() => {
    const t = store.getTask(taskId);
    if (!t?.activeAttemptId) return null;
    const a = store.getAttempt(t.activeAttemptId);
    if (!a || a.status !== "running") return null;
    // 等到 usage 行里真的出现了非零 token 再杀：否则"杀前总数"是 0，
    // 后面"被取代的 Attempt 数字不再增长"这条断言就没有任何区分力。
    const rows = store.getUsage(taskId).filter((u) => u.attemptId === a.id && u.totalTokens > 0);
    if (rows.length === 0) return null;
    return a;
  }, left(), 500);
  if (!claimed) {
    ev.push(`杀之前没等到 running + 非零 usage 的 Attempt：task.status=${store.getTask(taskId).status}；`
      + `worker#1 pid=${w1.pid} exit=${JSON.stringify(w1.exit)}；usage=${JSON.stringify(store.getUsage(taskId))}`);
    ev.push(`worker#1 日志尾部：${tail(w1.logFile)}`);
    record("6", title, "BLOCKED", ev);
    return;
  }
  const a1 = claimed;
  const psLine = (() => { try { return execFileSync("ps", ["-o", "pid=,ppid=,etime=,command=", "-p", String(w1.pid)], { encoding: "utf8" }); } catch { return "(ps 不可用)"; } })();
  let kids = [];
  try { kids = execFileSync("pgrep", ["-P", String(w1.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { /* 没有子进程 */ }
  ev.push(`worker#1 = 真独立进程 pid=${w1.pid}，ps: ${clip(psLine, 150)}`);
  ev.push(`worker#1 的直接子进程：${kids.join(", ") || "（未探到；pi 由 bundle 再派生一层）"}`);
  ev.push(`杀前：Attempt id=${a1.id.slice(0, 13)} sequence=${a1.sequence} status=${a1.status} fencing=${a1.fencingToken} worker=${clip(a1.workerId, 28)} lease_expires_at=${new Date(a1.leaseExpiresAt).toISOString()}`);
  const before = store.getUsage(taskId);
  const totalBefore = before.reduce((s, u) => s + u.totalTokens, 0);
  const a1Before = before.filter((u) => u.attemptId === a1.id).reduce((s, u) => s + u.totalTokens, 0);
  ev.push(`杀前 usage 行（getUsage(taskId)）：${before.map((u) => `${u.attemptId.slice(0, 11)}/${u.provider}/${u.model}=tokens ${u.totalTokens} cost ${u.totalCost.toFixed(6)}`).join(" | ") || "（无）"}`);
  ev.push(`杀前 token 总数 A=${totalBefore}（其中 Attempt#${a1.sequence} = ${a1Before}）`);

  const via = killWorker(w1);
  const gone = await waitFor(() => (w1.exit ?? (alive(w1.pid) ? null : { synthetic: true })), 10_000, 200);
  ev.push(`${via} → worker#1 退出记录=${JSON.stringify(gone)}；pid=${w1.pid} 现在存活=${alive(w1.pid)}`);
  const mid = store.getTask(taskId);
  ev.push(`杀后立刻读：task.status=${mid.status} active_attempt=${mid.activeAttemptId?.slice(0, 11) ?? "无"} attempts=${store.getAttempts(taskId).map((x) => `#${x.sequence}/${x.status}`).join(",")}`);

  const w2 = spawnWorker(`resume-${hex(3)}`);
  ev.push(`worker#2 pid=${w2.pid} 重启，同一个 SQLite=${rel(DB)}（租约 30s、心跳 ≤10s 续租；过期后 recoverExpired 才接管，Q37 接管另加 4–6s 退避 —— 等不到不是卡死）`);
  const orphaned = await waitFor(() => {
    const a = store.getAttempt(a1.id);
    return a.status === "orphaned" ? a : null;
  }, left(), 1000);
  if (!orphaned) {
    const t = store.getTask(taskId);
    ev.push(`等接管超时：task.status=${t.status}；attempts=${store.getAttempts(taskId).map((x) => `#${x.sequence}/${x.status}/lease ${new Date(x.leaseExpiresAt).toISOString()}`).join(",")}`);
    ev.push(`worker#2 日志尾部：${tail(w2.logFile)}`);
    record("6", title, "BLOCKED", ev);
    return;
  }
  const afterOrphan = store.getTask(taskId);
  ev.push(`接管：Attempt#${orphaned.sequence} status=${orphaned.status} error=${clip(orphaned.error, 180)}`);
  ev.push(`接管后 task.status=${afterOrphan.status} batch_attempts=${afterOrphan.batchAttempts} fencing_token=${afterOrphan.fencingToken}（fencing +1 → 旧 Attempt 的迟到写入会被拒）`);
  if (afterOrphan.status === "blocked") {
    ev.push(`接管判定 blocked：被杀时确有未见底的工具调用 → Q18/Q21「未知副作用需人工确认」的真实行为。走真实 API POST /api/tasks/:id/confirm 继续。`);
    const c = await fetch(`${base}/api/tasks/${taskId}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "I10 验收：杀进程实验；工作区重复写入可覆盖，确认继续" }),
    });
    ev.push(`confirm → HTTP ${c.status}；task.status=${store.getTask(taskId).status}`);
  }

  const finished = await waitFor(() => {
    const t = store.getTask(taskId);
    return TERMINAL.has(t.status) ? t : null;
  }, left(), 1000);
  const final = store.getTask(taskId);
  const attempts = store.getAttempts(taskId);
  const usageAll = store.getUsage(taskId);
  const totalAfter = usageAll.reduce((s, u) => s + u.totalTokens, 0);
  const a1After = usageAll.filter((u) => u.attemptId === a1.id).reduce((s, u) => s + u.totalTokens, 0);
  ev.push(`最终：task.status=${final.status}（等待器${finished ? "命中" : "超时"}）`);
  ev.push(`Attempt 序列：${attempts.map((x) => `#${x.sequence} status=${x.status} fence=${x.fencingToken} worker=${clip(x.workerId, 24)}`).join(" | ")}`);
  ev.push(`最终 result.summary：${clip(final.result?.summary, 300) || `（无 result；error=${clip(final.error, 200)}）`}`);
  dumpTasks(ev, h.id);
  const replyCount = msgsOf(h.id, "agent", pm.id).length;
  ev.push(`${pm.name} 在群里说了几次（重放不得让它说两遍，Q39 幂等）：${replyCount}；内容=${clip(msgsOf(h.id, "agent", pm.id).at(-1)?.content, 260)}`);
  ev.push(`杀前/杀后 token 总数：A=${totalBefore} → B=${totalAfter}`);
  ev.push(`被杀的 Attempt#${a1.sequence}：杀前=${a1Before} → 杀后=${a1After}（迟到写入被 fencing 拒 → 必须不变：${a1After === a1Before}）`);
  ev.push(`杀后 usage 行：${usageAll.map((u) => `${u.attemptId.slice(0, 11)}/${u.provider}/${u.model}=tokens ${u.totalTokens} cost ${u.totalCost.toFixed(6)}`).join(" | ")}`);

  // 同一 (attempt, provider, model) 上：N 条累计 usage 事件 → 入库必须等于 MAX，而不是求和。
  const evs = store.getEvents(taskId, 0, 2000);
  const per = new Map();
  for (const e of evs) {
    if (!e.event.usage) continue;
    const k = `${e.attemptId}|${e.event.provider ?? "unknown"}|${e.event.model ?? "unknown"}`;
    const cur = per.get(k) ?? { n: 0, sum: 0, max: 0 };
    cur.n += 1; cur.sum += e.event.usage.totalTokens; cur.max = Math.max(cur.max, e.event.usage.totalTokens);
    per.set(k, cur);
  }
  for (const [k, v] of per) {
    const stored = usageAll.find((u) => `${u.attemptId}|${u.provider}|${u.model}` === k);
    ev.push(`去重核对 (attempt,provider,model)=${k.split("|").map((s) => s.slice(0, 11)).join("/")}：带 usage 的事件 ${v.n} 条 → 朴素求和=${v.sum}，MAX=${v.max}，入库=${stored?.totalTokens ?? "无行"}`);
  }
  const dedupOk = per.size > 0 && [...per.entries()].every(([k, v]) => {
    const stored = usageAll.find((u) => `${u.attemptId}|${u.provider}|${u.model}` === k);
    return !!stored && stored.totalTokens === v.max;
  });
  const rowKeys = usageAll.map((u) => `${u.attemptId}|${u.provider}|${u.model}`);
  const uniqueRows = new Set(rowKeys).size === rowKeys.length;
  const replayed = attempts.some((x) => x.sequence > a1.sequence && x.status === "completed");
  ev.push(`口径说明：重放是真实的第二次运行，所以 B ≥ A 属正常；「无重复计费」指的是同一 Attempt 的累计 usage 只记 MAX（${dedupOk}）、`
    + `被取代的 Attempt 数字不再增长（${a1After === a1Before}）、usage 主键无重复行（${uniqueRows}）、重放没让 agent 在群里说两遍（回复条数=${replyCount}）。`);
  const ok = final.status === "succeeded" && orphaned.status === "orphaned" && replayed
    && a1After === a1Before && dedupOk && uniqueRows && replyCount === 1;
  record("6", title, ok ? "PASS" : "FAIL", ev);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
log("=== PRD §6 真实模型验收（I10 / P8 群聊） ===");
log(`model              : ${MODEL}`);
log(`provider 配置       : ~/.pi/agent/models.json（内容与凭据一律不读取、不打印）`);
log(`隔离工作区          : ${WORK}`);
log(`共享 SQLite         : ${rel(DB)}`);
log(`模板包              : ${rel(ZIP)}`);
log(`MTA_RUNTIME         : ${RUNTIME_ENV === undefined ? "未设置 → runtimeFor() 走真实 PiAdapter" : RUNTIME_ENV}`);
log(`单项硬上限          : ${ITEM_MS / 1000}s；串行执行，不并发打爆 provider`);
log(`本次只跑第几项       : ${ONLY.join(",") || "1-6"}`);

const { base, app } = await startServer();
log(`真实服务端          : ${base}（buildApp + /api/rooms + /api/tasks + /api/pi）`);
log(`同库同句柄          : RoomStore.db === ExecutionStore.db → ${rooms.db === store.db}`);
const MAIN = spawnWorker(`main-${hex(3)}`);
log(`真实 durable worker : 独立进程 pid=${MAIN.pid}（${rel(WORKER_ENTRY)}，MTA_DB_PATH=${rel(DB)}）`);

/**
 * 统一收尾。预检中止也必须走这里：worker 是 `detached` 独立进程组，直接
 * `process.exit` 不会杀它，会留下一个绑在临时 SQLite 上的野进程和一堆 /tmp 产物。
 * （早于 WORK/store 创建的前置检查用 `abort`，那时没有东西要收。）
 */
function teardown(code) {
  for (const w of workers) killWorker(w);
  try { store.close(); } catch { /* ignore */ }
  if (process.env.MTA_I10_KEEP === "1") log(`\n产物保留在 ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
  process.exit(code);
}

// An external `timeout`/Ctrl-C kills only THIS process; the worker is detached in
// its own process group and survives, holding the temp SQLite. Measured: `timeout
// 1100` on the full six-item run left a live worker (18m elapsed) and its temp dir
// behind. So a signal must still go through teardown. Registered here because
// WORK/store/workers exist from this point on.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}，回收 worker 与临时目录后退出`);
    teardown(130);
  });
}

/** 前置条件不满足（含 provider 不应答）：退出码 2，且必须先把 worker 收掉。 */
function abortInfra(msg, hint) {
  console.error(`\nABORT: ${msg}${hint ? `\n  ${hint}` : ""}`);
  teardown(2);
}

/**
 * provider 预检 —— "provider 会挂"的务实解法。
 *
 * 实测过的代价：provider 挂起时，六项各自烧满单项预算（每项 5 分钟），最后产出一
 * 墙 BLOCKED，而且"provider 无响应"和"产品缺陷"在那一墙里长得一模一样 —— 我就是
 * 这样两次误诊过（r7 三次 Attempt 撞无事件超时被我读成"模型不肯收尾"；一次饿死被
 * 我读成"预算耗尽"）。
 *
 * 所以进场先花一轮极小的真实模型调用验证「模型能应答」：preflight 自己的 Task 在
 * 预算内成功 → 继续六项；撞无事件超时 / 超预算 → 直接以退出码 2 结束（与"pi 缺失"
 * 同类：前置条件不满足），并写明这是基础设施故障，不是被测系统结论。
 *
 * 不把预检塞进 item 1 的原因：item 1（导入）不需要模型，`MTA_I10_ITEMS=1` 单独跑
 * 导入验收不该被 provider 状态绑架；预检只在本次确实要跑需要模型的项时执行。
 */
async function preflightProvider(base) {
  const budget = PREFLIGHT_MS;
  const t0 = Date.now();
  const h = await importRoom(base, "i10-preflight");
  if (h.error) abortInfra(`预检导入失败：${h.error}`);
  const agent = h.agents[0];
  if (!agent) abortInfra("预检群没有可用 agent");
  const r = await post(base, h.id, `@${agent.name} 只回一句「就绪」，不要使用任何工具。`);
  if (r.status >= 400) abortInfra(`预检消息被拒：HTTP ${r.status} ${clip(JSON.stringify(r.body), 240)}`);
  const taskId = (r.body.tasks ?? [])[0]?.id;
  if (!taskId) abortInfra("预检没有派发出 Task");
  for (;;) {
    const task = store.getTask(taskId);
    const hung = store.getAttempts(taskId).find((a) => (a.error ?? "").includes("no events for"));
    if (hung) abortInfra(
      `provider 预检撞无事件超时（Attempt#${hung.sequence}：${clip(hung.error, 160)}）。`
      + "这是 provider 挂起，不是被测系统行为 —— stall watchdog 在 provider 无响应时中止该 Attempt，六项都不会产生可判定证据。",
      `恢复 provider 后重跑；想跳过预检用 MTA_I10_SKIP_PREFLIGHT=1（结论会退化成逐项 BLOCKED）。`,
    );
    if (task && TERMINAL.has(task.status)) {
      if (task.status !== "succeeded") abortInfra(`provider 预检失败：Task 终态=${task.status}，error=${clip(task.error, 200)}`);
      const text = modelText(taskId);
      log(`provider 预检通过：${agent.name} 在 ${((Date.now() - t0) / 1000).toFixed(1)}s 内应答「${clip(text, 80)}」`);
      return;
    }
    if (Date.now() - t0 > budget) {
      const a = store.getAttempts(taskId).at(-1);
      abortInfra(`provider 预检超时：${budget / 1000}s 内无成功响应（task.status=${task?.status ?? "未知"}，最后一次 Attempt=${a?.status ?? "无"} ${clip(a?.error, 160)}）`);
    }
    await sleep(1000);
  }
}

const suite = [[1, () => item1(base)], [2, () => item2(base)], [3, () => item3(base)],
  [4, () => item4(base)], [5, () => item5(base)], [6, () => item6(base, MAIN)]].filter(([n]) => want(n));

const needsModel = suite.some(([n]) => n !== 1);
if (needsModel && process.env.MTA_I10_SKIP_PREFLIGHT !== "1") {
  log("── provider 预检：进场先证一次「真实模型能应答」（MTA_I10_SKIP_PREFLIGHT=1 可跳过）──");
  await preflightProvider(base);
}

for (const [n, fn] of suite) {
  const t0 = Date.now();
  log(`\n──────── item ${n} 开始（真实模型 ${MODEL}）────────`);
  try { await fn(); }
  catch (err) {
    const msg = err instanceof Error ? `${err.message} @ ${String(err.stack).split("\n")[1]?.trim() ?? ""}` : String(err);
    record(String(n), `item ${n}`, "FAIL", [`脚本自身异常（不代表被测系统）：${msg}`]);
  }
  log(`──────── item ${n} 结束，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ────────`);
}

log("\n=== 汇总（每项结论对应上面的证据）===");
for (const r of results) log(`  ${r.n}. ${String(r.status).padEnd(7)} ${r.title}`);
const allPass = results.length === 6 && results.every((r) => r.status === "PASS");
if (results.length !== 6) log(`  注意：本次只跑了 ${results.length}/6 项 → 退出码非 0（MTA_I10_ITEMS=${process.env.MTA_I10_ITEMS ?? ""}）`);

try { await app.close(); } catch { /* ignore */ }
log(`退出码 ${allPass ? 0 : 1}（0 仅当六项全部 PASS；2 表示前置条件不满足，不是产品结论）`);
teardown(allPass ? 0 : 1);
