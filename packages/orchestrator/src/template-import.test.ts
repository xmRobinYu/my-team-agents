import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RoomStore, type CreateRoomAgentInput } from "./room-store.js";
import {
  importTemplatePackage,
  parseFrontmatter,
  parseTemplatePackage,
  planTemplateImport,
  resolveCoordinator,
  TemplateImportError,
  type ParsedTemplate,
  type ZipSource,
} from "./template-import.js";

/**
 * Fixtures are the smallest packages that stay structurally faithful to a real
 * teamagentx export — same file set, same field names, same nesting. The real
 * `全栈软件研发` zip is exercised at the bottom, skipped where `ref/` (an
 * untracked local reference tree) is absent.
 */

const ROOM_ID = "4061951d-0ce4-4ecd-a232-8151c1c041e5";
const LEAD_ID = "dbef6cfa-d486-429c-b0eb-f607b583b10d";
const PM_ID = "9660ba1c-8f18-4290-bab2-57018b4da871";

interface AgentSpec {
  id: string;
  name: string;
  prompt?: string;
  acpTool?: string | null;
  speechConfig?: unknown;
  proxyConfig?: unknown;
  codexModel?: string | null;
}

const manifestOf = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: "1.0",
  templateId: `tpl-room-${ROOM_ID}`,
  version: "1.0.0",
  title: "全栈软件研发",
  summary: null,
  source: { type: "local", author: null, channel: null },
  contents: { group: true, agents: 5, categories: 1, skills: 0, cronTasks: 0 },
  ...overrides,
});

const persona = (slug: string, description: string, extraKey = "") =>
  [
    "---",
    `name: ${slug}`,
    `description: ${description}`,
    "color: indigo",
    "emoji: 🏛️",
    "vibe: Ships.",
    extraKey,
    "---",
    `# ${slug}`,
    "You are a specialist.",
  ].filter((line) => line !== "").join("\n");

const ROSTER = [
  "👑 齐活林（交付总监）",
  "• 许清楚（产品经理）",
  "• 高见远（架构师）",
  "• 寇豆码（工程师）",
  "• 严过关（QA工程师）",
].join("\n");

const rulesOf = (roster = ROSTER) => `## 团队简介\n高效软件研发团队\n\n## 团队成员\n${roster}\n`;

const agentJson = (a: AgentSpec) => ({
  id: a.id,
  name: a.name,
  prompt: a.prompt ?? persona(`software-${a.name}`, `${a.name} role`),
  type: "builtin",
  acpTool: a.acpTool ?? null,
  categoryId: "54b4d533-28e2-4e7f-b82e-6497afae1e89",
  workDir: null,
  proxyConfig: a.proxyConfig ?? null,
  codexModel: a.codexModel ?? null,
  codexFastMode: false,
  claudeModel: null,
  thinkingMode: "high",
  llmProviderId: null,
  speechConfig: a.speechConfig ?? null,
  capabilities: [],
});

const fiveAgents = (): AgentSpec[] => [
  { id: "594819e1-4bad-414c-8dff-6b83e0dde574", name: "高见远" },
  { id: PM_ID, name: "许清楚" },
  { id: "996a6da7-05d4-4830-a8dd-5ebdd5353d34", name: "严过关" },
  { id: "b193c3d2-f0ee-41e8-9659-4fa97da53797", name: "寇豆码" },
  { id: LEAD_ID, name: "齐活林" },
];

const snapshotOf = (
  agents: AgentSpec[],
  room: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
) => JSON.stringify({
  room: {
    id: ROOM_ID,
    name: "全栈软件研发",
    description: "高效软件研发团队",
    rules: rulesOf(),
    workDir: null,
    defaultAgentId: LEAD_ID,
    agentTriggerMode: "auto",
    ...room,
  },
  agents: agents.map(agentJson),
  categories: [{ id: "54b4d533-28e2-4e7f-b82e-6497afae1e89", name: "全栈软件研发", sortOrder: 10 }],
  cronTasks: [],
  ...top,
});

interface PackageParts {
  manifest?: string;
  snapshot?: string;
  capability?: string;
  usages?: string;
  degraded?: string;
  skills?: Record<string, string>;
  omit?: string[];
}

const pack = (parts: PackageParts = {}): ZipSource => {
  const agents = fiveAgents();
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(parts.manifest ?? manifestOf()),
    "snapshot.json": strToU8(parts.snapshot ?? snapshotOf(agents)),
    "capability-descriptors.json": strToU8(
      parts.capability ?? JSON.stringify(
        agents.map((a) => ({
          agentRef: a.id, capabilityType: "text", required: true, tool: null, modelType: "text",
        })),
      ),
    ),
    "skill-usages.json": strToU8(parts.usages ?? "[]"),
    "degraded-skills.json": strToU8(parts.degraded ?? "[]"),
  };
  for (const [path, text] of Object.entries(parts.skills ?? {})) files[`skills/${path}`] = strToU8(text);
  for (const gone of parts.omit ?? []) delete files[gone];
  return new Uint8Array(zipSync(files));
};

const tempDir = mkdtempSync(join(tmpdir(), "template-import-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/** One store + one rooms root per case, so a failure cannot leak state sideways. */
const harness = (name: string) => {
  const base = join(tempDir, name);
  mkdirSync(base, { recursive: true });
  const store = new RoomStore(join(base, "rooms.sqlite"));
  const roomsRoot = join(base, ".rooms");
  return {
    store,
    roomsRoot,
    import: (zip: ZipSource, projectId = "my-team-agents") =>
      importTemplatePackage({ zip, store, projectId, roomsRoot }),
  };
};

const codes = (parsed: ParsedTemplate) => parsed.warnings.map((w) => w.code);

describe("parseTemplatePackage — happy path", () => {
  it("reads the room and its 5 agents", () => {
    const parsed = parseTemplatePackage(pack());
    expect(parsed.room.name).toBe("全栈软件研发");
    expect(parsed.room.rules).toContain("## 团队成员");
    expect(parsed.agents.map((a) => a.name)).toEqual(["高见远", "许清楚", "严过关", "寇豆码", "齐活林"]);
    expect(parsed.manifest.roomRef).toBe(ROOM_ID);
    const architect = parsed.agents[0];
    expect(architect?.role).toBe("架构师");
    expect(architect?.emoji).toBe("🏛️");
    expect(architect?.color).toBe("indigo");
    expect(parsed.defaultAgentRef).toBe(LEAD_ID);
  });

  it("reports non-migrated fields instead of swallowing them", () => {
    const parsed = parseTemplatePackage(pack({
      snapshot: snapshotOf([
        ...fiveAgents().slice(0, 4),
        {
          id: LEAD_ID,
          name: "齐活林",
          acpTool: "claude",
          proxyConfig: { http: "127.0.0.1:7890" },
          codexModel: "gpt-5.4",
          speechConfig: { behavior: { enabled: true } },
        },
      ]),
    }));
    const forLead = (field: string) =>
      parsed.ignoredFields.find((f) => f.field === field && f.agentName === "齐活林");
    for (const field of ["speechConfig", "proxyConfig", "codexModel", "acpTool"]) {
      expect(forLead(field), `${field} must be reported`).toBeDefined();
    }
    expect(forLead("speechConfig")?.reason).toContain("不在 ChatRoom 领域模型内");
    expect(forLead("proxyConfig")?.value).toContain("7890");
    // categories exist and are non-empty: recorded AND warned (Q31)
    expect(parsed.ignoredFields.find((f) => f.field === "categories")?.reason).toContain("不迁移（Q31）");
    expect(codes(parsed)).toContain("categories-not-migrated");
    // cronTasks is empty here, so it is recorded without a warning
    expect(parsed.ignoredFields.some((f) => f.field === "cronTasks")).toBe(true);
    expect(codes(parsed)).not.toContain("cronTasks-not-migrated");
  });

  it("drops cronTasks and categories but never silently", () => {
    const parsed = parseTemplatePackage(pack({
      snapshot: snapshotOf(fiveAgents(), {}, {
        categories: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }],
        cronTasks: [{ id: "t1", name: "每天 9 点" }],
      }),
    }));
    expect(codes(parsed)).toEqual(
      expect.arrayContaining(["categories-not-migrated", "cronTasks-not-migrated"]),
    );
    expect(parsed.ignoredFields.find((f) => f.field === "cronTasks")?.value).toContain("1 个定时任务");
  });

  it("materialises skills from skill-usages into the plan", () => {
    const zip = pack({
      usages: JSON.stringify([{ agentId: LEAD_ID, slug: "brainstorming" }, { agentId: PM_ID, slug: "browser-use" }]),
      skills: {
        "brainstorming/SKILL.md": "# brainstorming\n",
        "brainstorming/.teamagentx-template/skill-metadata.json": '{"slug":"brainstorming"}',
        "browser-use/SKILL.md": "# browser-use\n",
      },
    });
    const plan = planTemplateImport(zip, { projectId: "p", roomsRoot: join(tempDir, "plan-only") });
    const lead = plan.agents.find((a) => a.input.isCoordinator);
    const pm = plan.agents.find((a) => a.input.name === "许清楚");
    expect(lead?.skills).toEqual(["brainstorming"]);
    expect(pm?.skills).toEqual(["browser-use"]);
    expect(lead?.files).toContain("skills/brainstorming/SKILL.md");
    expect(lead?.files).toContain("skills/brainstorming/.teamagentx-template/skill-metadata.json");
    expect(Object.keys(plan.parsed.skillFiles).sort()).toEqual(["brainstorming", "browser-use"]);
    expect(existsSync(plan.roomRoot)).toBe(false); // planning touches no disk
  });

  it("warns instead of crashing when a referenced skill has no files", () => {
    const parsed = parseTemplatePackage(pack({
      usages: JSON.stringify([{ agentId: LEAD_ID, slug: "ghost-skill" }]),
    }));
    expect(parsed.warnings.find((w) => w.code === "skill-files-missing")?.message).toContain("ghost-skill");
    expect(parsed.agents.find((a) => a.templateAgentId === LEAD_ID)?.skillSlugs).toEqual([]);
  });

  it("warns about skill files no agent claims", () => {
    const parsed = parseTemplatePackage(pack({ skills: { "orphan/SKILL.md": "# x\n" } }));
    expect(parsed.warnings.find((w) => w.code === "skill-unattributed")?.message).toContain("orphan");
  });

  it("tolerates an unparsable side file", () => {
    const parsed = parseTemplatePackage(pack({ usages: "{not json" }));
    expect(codes(parsed)).toContain("file-invalid-json");
    expect(parsed.agents).toHaveLength(5);
  });

  it("keeps a manifest/snapshot count disagreement a warning unless strict", () => {
    const zip = pack({ manifest: manifestOf({ contents: { agents: 9 } }) });
    expect(codes(parseTemplatePackage(zip))).toContain("declared-count-mismatch");
    expect(() => parseTemplatePackage(zip, { strictCounts: true })).toThrow(/SCHEMA_MISMATCH/);
  });

  it("records degraded-skills as a warning", () => {
    const parsed = parseTemplatePackage(pack({
      degraded: JSON.stringify([{ slug: "browser-use", reason: "too big" }]),
    }));
    expect(codes(parsed)).toContain("degraded-skills");
  });
});

describe("parseTemplatePackage — explicit failures", () => {
  const expectCode = (zip: ZipSource, code: TemplateImportError["code"]) => {
    try {
      parseTemplatePackage(zip);
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateImportError);
      expect((err as TemplateImportError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${code}, got no throw`);
  };

  it("missing manifest.json", () => expectCode(pack({ omit: ["manifest.json"] }), "FILE_MISSING"));
  it("missing snapshot.json", () => expectCode(pack({ omit: ["snapshot.json"] }), "FILE_MISSING"));
  it("truncated JSON in snapshot", () => expectCode(pack({ snapshot: '{"room": {"name": "全栈"' }), "JSON_INVALID"));
  it("garbage in manifest", () => expectCode(pack({ manifest: "not json at all" }), "JSON_INVALID"));
  it("unsupported schemaVersion", () =>
    expectCode(pack({ manifest: manifestOf({ schemaVersion: "2.0" }) }), "SCHEMA_MISMATCH"));
  it("missing schemaVersion", () => {
    const bare = JSON.parse(manifestOf()) as Record<string, unknown>;
    delete bare.schemaVersion;
    expectCode(pack({ manifest: JSON.stringify(bare) }), "SCHEMA_MISMATCH");
  });

  it("room absent or nameless", () => {
    expectCode(pack({ snapshot: JSON.stringify({ agents: [], room: null }) }), "ROOM_INVALID");
    expectCode(pack({ snapshot: JSON.stringify({ room: { description: "" }, agents: [] }) }), "ROOM_INVALID");
  });

  it("agents absent or empty", () => {
    expectCode(pack({ snapshot: JSON.stringify({ room: { id: ROOM_ID, name: "x" } }) }), "AGENTS_INVALID");
    expectCode(
      pack({ snapshot: JSON.stringify({ room: { id: ROOM_ID, name: "x" }, agents: [] }) }),
      "AGENTS_INVALID",
    );
  });

  it("agent without name or prompt", () => {
    expectCode(
      pack({ snapshot: JSON.stringify({ room: { id: ROOM_ID, name: "x" }, agents: [{ id: "1" }] }) }),
      "AGENT_INVALID",
    );
    expectCode(
      pack({ snapshot: JSON.stringify({ room: { id: ROOM_ID, name: "x" }, agents: [{ id: "1", name: "a" }] }) }),
      "AGENT_INVALID",
    );
  });

  it("duplicate agent names are refused — @mentions and dirs must stay unique", () => {
    expectCode(pack({
      snapshot: JSON.stringify({
        room: { id: ROOM_ID, name: "x", defaultAgentId: "1" },
        agents: [
          { id: "1", name: "同名", prompt: "p1" },
          { id: "2", name: "同名", prompt: "p2" },
        ],
      }),
    }), "AGENT_INVALID");
  });

  it("not a zip at all", () => expectCode(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]), "ZIP_INVALID"));
  it("an unreadable path is a clear error", () => expectCode(join(tempDir, "nope.zip"), "ZIP_UNREADABLE"));
});

describe("coordinator identification", () => {
  it("uses room.defaultAgentId when the package declares one", () => {
    const parsed = parseTemplatePackage(pack());
    const decision = resolveCoordinator(parsed);
    expect(decision.source).toBe("room.defaultAgentId");
    expect(decision.agentName).toBe("齐活林");
    expect(decision.templateAgentId).toBe(LEAD_ID);
    expect(codes(parsed)).not.toContain("coordinator-undetermined");
  });

  it("falls back to a single heuristic match when defaultAgentId is missing", () => {
    const agents = fiveAgents().map((a) =>
      a.name === "许清楚" ? { ...a, prompt: persona("software-team-lead", "lead", "role: lead") } : { ...a, prompt: `# ${a.name}\n干活。` },
    );
    const parsed = parseTemplatePackage(pack({
      snapshot: snapshotOf(agents, { defaultAgentId: null, rules: "## 团队\n三个普通成员" }),
    }));
    const decision = resolveCoordinator(parsed);
    expect(decision.source).toBe("heuristic");
    expect(decision.agentName).toBe("许清楚");
    expect(decision.rationale).toContain("启发式");
  });

  it("recognises 交付总监 from the roster line via role", () => {
    // Neutral prompts (no persona frontmatter, no lead words); the roster in
    // room.rules is the only lead-ish signal left.
    const agents = fiveAgents().map((a) => ({ ...a, prompt: `# ${a.name}\n干活。` }));
    const parsed = parseTemplatePackage(pack({
      snapshot: snapshotOf(agents, { defaultAgentId: null }),
    }));
    const decision = resolveCoordinator(parsed);
    expect(decision.source).toBe("heuristic");
    expect(decision.agentName).toBe("齐活林");
  });

  it("falls back to the first agent with an explicit warning when undecidable", () => {
    const agents = fiveAgents().map((a) => ({ ...a, prompt: `# ${a.name}\n干活。` }));
    const parsed = parseTemplatePackage(pack({
      snapshot: snapshotOf(agents, { defaultAgentId: null, rules: "## 团队\n三个普通成员" }),
    }));
    const decision = resolveCoordinator(parsed);
    expect(decision.source).toBe("fallback-first-agent");
    expect(decision.agentName).toBe("高见远"); // agents[0]
    const warning = parsed.warnings.find((w) => w.code === "coordinator-undetermined");
    expect(warning?.message).toContain("回退为「第一个 agent」");
    expect(warning?.message).toContain("defaultAgentId 缺失");
    expect(warning?.agentName).toBe("高见远");
  });

  it("a dangling defaultAgentId degrades with a warning, not a silent pick", () => {
    const parsed = parseTemplatePackage(pack({ snapshot: snapshotOf(fiveAgents(), { defaultAgentId: "no-such" }) }));
    const decision = resolveCoordinator(parsed); // the warning is emitted when the decision is made
    expect(codes(parsed)).toContain("coordinator-default-unresolvable");
    expect(["heuristic", "fallback-first-agent"]).toContain(decision.source);
  });

  it("the package's choice wins over a conflicting heuristic, and says so", () => {
    const agents = fiveAgents().map((a) =>
      a.name === "高见远" ? { ...a, prompt: persona("software-architect", "architect", "role: lead") } : a,
    );
    const parsed = parseTemplatePackage(pack({ snapshot: snapshotOf(agents) }));
    expect(resolveCoordinator(parsed).agentName).toBe("齐活林");
    expect(codes(parsed)).toContain("coordinator-heuristic-conflict");
  });

  it("an empty agent list cannot decide", () => {
    expect(() => resolveCoordinator({ agents: [], warnings: [] } as unknown as ParsedTemplate)).toThrow(/AGENTS_INVALID/);
  });

  it("the flag and room.coordinatorAgentId agree in the store", () => {
    const h = harness("coordinator-flag");
    const result = h.import(pack());
    const lead = result.agents.find((a) => a.isCoordinator);
    expect(lead?.name).toBe("齐活林");
    expect(result.room.coordinatorAgentId).toBe(lead?.id);
    expect(h.store.listAgents(result.room.id).filter((a) => a.isCoordinator)).toHaveLength(1);
    h.store.close();
  });
});

describe("importTemplatePackage — agent dirs and atomicity", () => {
  it("creates room + 5 agents, each with its own agentDir and AGENTS.md", () => {
    const h = harness("happy");
    const result = h.import(pack());
    expect(result.room.name).toBe("全栈软件研发");
    expect(result.room.rules).toContain("## 团队成员");
    expect(result.room.projectId).toBe("my-team-agents");
    expect(result.agents).toHaveLength(5);

    for (const agent of result.agents) {
      expect(agent.agentDir.startsWith(join(h.roomsRoot, ROOM_ID))).toBe(true);
      const agentsMd = join(agent.agentDir, "AGENTS.md");
      expect(existsSync(agentsMd), `AGENTS.md for ${agent.name}`).toBe(true);
      const text = readFileSync(agentsMd, "utf8");
      expect(text).toContain(agent.name);
      expect(text).toContain("## 群规则");
      expect(text).toContain("## 角色 prompt");
      expect(text).toContain(`name: software-${agent.name}`); // prompt kept verbatim
      expect(readdirSync(agent.agentDir)).toContain("skills");
      expect(existsSync(join(agent.agentDir, ".template-import.json"))).toBe(true);
    }

    const stored = h.store.listAgents(result.room.id);
    expect(stored).toHaveLength(5);
    expect(stored.find((a) => a.isCoordinator)?.role).toBe("交付总监");
    expect(stored.every((a) => a.thinkingMode === "high")).toBe(true);
    expect(existsSync(join(result.roomRoot, "import-report.json"))).toBe(true);
    // AGENTS.md + marker per agent, plus one report
    expect(result.filesWritten).toHaveLength(result.agentDirs.length * 2 + 1);
    h.store.close();
  });

  it("writes skill files inside the owning agent's agentDir", () => {
    const h = harness("skills");
    const result = h.import(pack({
      usages: JSON.stringify([{ agentId: LEAD_ID, slug: "brainstorming" }]),
      skills: { "brainstorming/SKILL.md": "# brainstorming skill\n" },
    }));
    const lead = result.agents.find((a) => a.isCoordinator);
    expect(readFileSync(join(lead?.agentDir ?? "", "skills", "brainstorming", "SKILL.md"), "utf8"))
      .toContain("brainstorming skill");
    const other = result.agents.find((a) => !a.isCoordinator);
    expect(readdirSync(join(other?.agentDir ?? "", "skills"))).toEqual([]);
    h.store.close();
  });

  it("rolls back the transaction and removes created dirs when the commit fails", () => {
    const h = harness("rollback");
    const zip = pack();
    const real = RoomStore.prototype.addAgent;
    let calls = 0;
    const spy = vi.spyOn(h.store, "addAgent").mockImplementation(((input: CreateRoomAgentInput, when?: number) => {
      calls += 1;
      if (calls < 2) return real.call(h.store, input, when);
      throw new Error("SQLITE_BUSY: database is locked");
    }) as never);

    try {
      expect(() => h.import(zip)).toThrow(/不留下半成品/);
    } finally {
      spy.mockRestore();
    }
    expect(h.store.listRooms()).toHaveLength(0);
    expect(h.store.db.prepare("SELECT COUNT(*) AS n FROM room_agents").get()).toEqual({ n: 0 });
    // the persona tree the import owns is gone; at most an empty rooms root remains
    expect(existsSync(h.roomsRoot) ? readdirSync(h.roomsRoot) : []).toEqual([]);
    expect(calls).toBe(2);
    h.store.close();
  });

  it("leaves nothing behind when the package fails to parse", () => {
    const h = harness("bad-package");
    expect(() => h.import(pack({ omit: ["manifest.json"] }))).toThrow(/FILE_MISSING/);
    expect(h.store.listRooms()).toHaveLength(0);
    expect(existsSync(h.roomsRoot)).toBe(false);
    h.store.close();
  });

  it("requires a project — agents must bind to one (Q34)", () => {
    const h = harness("no-project");
    expect(() => h.import(pack(), "   ")).toThrow(/projectId/);
    expect(h.store.listRooms()).toHaveLength(0);
    h.store.close();
  });

  it("repeated imports of the same package do not clobber each other", () => {
    const h = harness("twice");
    const first = h.import(pack());
    const second = h.import(pack());
    expect(first.room.id).not.toBe(second.room.id);
    expect(first.roomRoot).not.toBe(second.roomRoot);
    expect(existsSync(first.agentDirs[0] ?? "")).toBe(true);
    expect(existsSync(second.agentDirs[0] ?? "")).toBe(true);
    expect(h.store.listRooms()).toHaveLength(2);
    h.store.close();
  });

  it("carries the ignored-field report into the result and onto disk", () => {
    const h = harness("report");
    const result = h.import(pack());
    expect(result.ignoredFields.length).toBeGreaterThan(10);
    const report = JSON.parse(readFileSync(join(result.roomRoot, "import-report.json"), "utf8")) as {
      ignoredFields: unknown[];
      coordinator: { source: string; agentName: string };
      agents: Array<{ name: string; agentDir: string }>;
    };
    expect(report.coordinator).toMatchObject({ source: "room.defaultAgentId", agentName: "齐活林" });
    expect(report.ignoredFields).toHaveLength(result.ignoredFields.length);
    expect(report.agents).toHaveLength(5);
    h.store.close();
  });
});

describe("parseFrontmatter", () => {
  it("reads top-level scalars and ignores nested maps", () => {
    const fm = parseFrontmatter(
      ["---", "name: spread-officer", "displayName:", "  zh: 传播官", "version: 1.2.9", "emoji: 🎯", "---", "", "body"]
        .join("\r\n"),
    );
    expect(fm["name"]).toBe("spread-officer");
    expect(fm["version"]).toBe("1.2.9");
    expect(fm["emoji"]).toBe("🎯");
    expect(fm["displayName"]).toBeUndefined();
  });

  it("returns nothing without frontmatter", () => {
    expect(parseFrontmatter("你是报告撰写专家\n\n## 周报模板")).toEqual({});
  });

  it("does not mistake a mid-prompt separator for frontmatter", () => {
    expect(parseFrontmatter("你是专家\n---\n# 周工作报告\nname: fake")).toEqual({});
  });
});

/**
 * AC "解析 全栈软件研发 包". `ref/` is an untracked local tree, so this is
 * skipped where the reference packages are absent instead of failing CI.
 */
const REAL_ZIP = join(process.cwd(), "ref", "teamagentx-templates", "全栈软件研发-2026-06-03.zip");
describe.skipIf(!existsSync(REAL_ZIP))("real package 全栈软件研发-2026-06-03.zip", () => {
  it("parses into room + 5 agents with the declared coordinator", () => {
    const parsed = parseTemplatePackage(REAL_ZIP);
    expect(parsed.room.name).toBe("全栈软件研发");
    expect(parsed.agents.map((a) => a.name).sort()).toEqual(
      ["严过关", "寇豆码", "齐活林", "许清楚", "高见远"].sort(),
    );
    expect(parsed.agents.map((a) => a.role).sort()).toEqual(
      ["QA工程师", "产品经理", "工程师", "架构师", "交付总监"].sort(),
    );
    const decision = resolveCoordinator(parsed);
    expect(decision.source).toBe("room.defaultAgentId");
    expect(decision.agentName).toBe("齐活林");
    // the one non-empty optional section upstream ships is categories: recorded,
    // warned, and not migrated (Q31)
    expect(codes(parsed)).toEqual(["categories-not-migrated"]);
    const fields = new Set(parsed.ignoredFields.map((f) => f.field));
    for (const field of ["acpTool", "speechConfig", "proxyConfig", "codexModel", "categories", "cronTasks"]) {
      expect(fields.has(field), `${field} recorded`).toBe(true);
    }
  });

  it("imports into a real store and materialises 5 agentDirs", () => {
    const h = harness("real");
    const result = h.import(REAL_ZIP);
    expect(result.agents).toHaveLength(5);
    const lead = result.agents.find((a) => a.isCoordinator);
    expect(lead?.name).toBe("齐活林");
    expect(result.room.coordinatorAgentId).toBe(lead?.id);
    for (const agent of result.agents) {
      expect(readdirSync(agent.agentDir)).toContain("AGENTS.md");
      expect(statSync(join(agent.agentDir, "AGENTS.md")).size).toBeGreaterThan(500);
      expect(h.store.getAgent(agent.id)?.agentDir).toBe(agent.agentDir);
    }
    const architect = result.agents.find((a) => a.name === "高见远");
    expect(readFileSync(join(architect?.agentDir ?? "", "AGENTS.md"), "utf8")).toContain("Software Architect");
    h.store.close();
  });
});
