import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { RunSpec } from "@my-team-agents/runtime-core";
import { PiAdapter } from "./adapter.js";
import {
  HANDOFF_EXTENSION_FILE_NAME,
  PI_EXTENSIONS_DIR_NAME,
  handoffExtensionArgs,
  handoffExtensionPath,
} from "./handoff-extension.js";

const tempDir = mkdtempSync(join(tmpdir(), "handoff-ext-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

/**
 * D1: `handoff_to` did not exist. Pi 1.4.0 ships `read`/`bash`/`edit`/`write`
 * (+ `grep`/`find`/`ls`) and nothing else — measured against the installed binary:
 * asked to list its tools and then call `handoff_to`, a real model answered
 * "`handoff_to` is **not available** — it is not in my toolset". So the primary
 * dispatch branch of `orchestrator/durable-worker.ts` could never fire, and every
 * "handoff" observed in acceptance was the degraded `@name` path.
 *
 * These tests pin the three things that make the fix real rather than aspirational:
 * the path resolves identically from `src` and `dist`, the file exists on disk, and
 * the module it contains registers a tool whose name and parameter schema are the
 * ones `parseHandoffArgs` expects.
 */

/** What the loader hands to `pi.registerTool()`. */
interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

interface FakePi {
  tools: Map<string, RegisteredTool>;
  registerTool(tool: RegisteredTool): void;
}

const fakePi = (): FakePi => {
  const tools = new Map<string, RegisteredTool>();
  return { tools, registerTool: (tool) => { tools.set(tool.name, tool); } };
};

/** Load the shipped extension exactly the way Pi does: by absolute path. */
const loadExtension = async (): Promise<{ default: (pi: FakePi) => void }> => {
  const url = pathToFileURL(handoffExtensionPath()).href;
  return (await import(url)) as { default: (pi: FakePi) => void };
};

const register = async (): Promise<RegisteredTool> => {
  const pi = fakePi();
  (await loadExtension()).default(pi as never);
  const tool = pi.tools.get("handoff_to");
  if (!tool) throw new Error("the extension registered no handoff_to tool");
  return tool;
};

/**
 * The smallest JSON-Schema check for the subset the extension is allowed to use.
 * Hand-written on purpose: `runtime-pi` declares no dependency on Pi or on a schema
 * library, and the claim under test is exactly that the emitted schema is a plain,
 * standard JSON Schema object that `{toMemberIds:["a"], reason:"r"}` satisfies.
 */
function validate(schema: Record<string, unknown>, value: unknown): string[] {
  if (schema.type !== "object") return [`root must be an object schema, got ${String(schema.type)}`];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["payload must be an object"];
  const errors: string[] = [];
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const record = value as Record<string, unknown>;
  for (const key of required) {
    if (typeof key === "string" && record[key] === undefined) errors.push(`missing required "${key}"`);
  }
  for (const [key, sub] of Object.entries(properties)) {
    const got = record[key];
    if (got === undefined) continue;
    if (sub.type === "string" && typeof got !== "string") errors.push(`"${key}" must be a string`);
    if (sub.type === "array") {
      if (!Array.isArray(got)) { errors.push(`"${key}" must be an array`); continue; }
      const items = sub.items as Record<string, unknown> | undefined;
      if (items?.type === "string" && got.some((entry) => typeof entry !== "string")) {
        errors.push(`"${key}" must contain only strings`);
      }
    }
  }
  return errors;
}

describe("handoff extension path — src and dist are one fact", () => {
  it("resolves the same file from src/adapter.ts and from dist/adapter.js", () => {
    const fromSrc = handoffExtensionPath(pathToFileURL("/repo/packages/runtime-pi/src/adapter.ts").href);
    const fromDist = handoffExtensionPath(pathToFileURL("/repo/packages/runtime-pi/dist/adapter.js").href);
    expect(fromSrc).toBe(fromDist);
    expect(fromSrc).toBe(join("/repo", "packages", "runtime-pi", PI_EXTENSIONS_DIR_NAME, HANDOFF_EXTENSION_FILE_NAME));
  });

  it("is an uncompiled .js outside src/, so tsc can never fork a second copy", () => {
    const file = handoffExtensionPath();
    expect(file).toMatch(/pi-extensions[/\\]handoff-to\.js$/);
    expect(file).not.toContain(join("runtime-pi", "src"));
    expect(file).not.toContain(join("runtime-pi", "dist"));
    // vitest resolves through the src alias, production through dist: whichever
    // module asked, the file that must be on disk is this one.
    expect(existsSync(file)).toBe(true);
    // Nothing compiles a copy into dist/ — the package's tsconfig includes src only.
    expect(existsSync(join(file, "..", "..", "dist", PI_EXTENSIONS_DIR_NAME, HANDOFF_EXTENSION_FILE_NAME))).toBe(false);
  });

  it("argv fragment is one explicit --extension with an absolute path", () => {
    const args = handoffExtensionArgs();
    expect(args).toEqual(["--extension", handoffExtensionPath()]);
    expect(args[1]).toMatch(/^\//);
  });
});

describe("the extension module registers handoff_to", () => {
  it("exports a default factory that calls pi.registerTool with the exact name", async () => {
    const mod = await loadExtension();
    expect(typeof mod.default).toBe("function");
    const pi = fakePi();
    mod.default(pi as never);
    expect([...pi.tools.keys()]).toEqual(["handoff_to"]);
  });

  it("declares the parameter schema parseHandoffArgs expects", async () => {
    const tool = await register();

    // Pi's own loader requirement (dist/core/extensions/loader.js:236): the schema
    // must be a plain object — not a function, not an array.
    expect(typeof tool.parameters).toBe("object");
    expect(Array.isArray(tool.parameters)).toBe(false);
    expect(tool.parameters.type).toBe("object");

    const required = tool.parameters.required as string[];
    expect(required).toContain("toMemberIds");
    expect(required).toContain("reason");

    // The positive cases, including the optional workPackage the worker reads.
    expect(validate(tool.parameters, { toMemberIds: ["a"], reason: "r" })).toEqual([]);
    expect(validate(tool.parameters, { toMemberIds: ["a"], reason: "r", workPackage: "do it" })).toEqual([]);
    // And the negatives, so the schema is not decorative: a payload the parser would
    // reject for having no target must also fail here.
    expect(validate(tool.parameters, { reason: "r" }).length).toBeGreaterThan(0);
    expect(validate(tool.parameters, { toMemberIds: [1], reason: "r" }).length).toBeGreaterThan(0);
  });

  it("documents what the roster actually accepts — no invented id requirement (D5-b)", async () => {
    const tool = await register();
    const docs = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
    expect(tool.description).toMatch(/member/i);
    expect(JSON.stringify(tool.parameters)).toContain("toMemberIds");
    expect(JSON.stringify(tool.parameters)).toContain("workPackage");

    // The claim that used to be a lie: the schema demanded "Exact ids … taken from
    // the roster" while the roster the model was injected with held no id at all, so
    // a real run went `bash`-hunting through `.template-import.json` to guess one.
    // The doc must name all three accepted forms and the pointability of the roster.
    for (const form of [/name/i, /role/i, /\bid\b/i]) {
      expect(docs, `the schema must say it accepts ${form}`).toMatch(form);
    }
    expect(docs).toContain("# 成员");
    // And it must not over-promise: an id-only phrasing is the defect, and a tool
    // that says "any name works" would invite the mis-dispatch D5-a closes.
    expect(docs).not.toMatch(/exact ids/i);
    expect(docs).toMatch(/refus|not dispatch|never guesses/i);
  });

  it("execute() only acknowledges: it touches no context and dispatches nothing", async () => {
    const tool = await register();

    // Any property read on the extension context throws: `execute()` must not reach
    // the session, the filesystem or a spawn. Dispatch belongs to the durable
    // worker's commit transaction (P6 / Q39, Q40), not to the model's tool call.
    const touched: string[] = [];
    const forbiddenCtx = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        touched.push(String(prop));
        throw new Error(`execute() touched ctx.${String(prop)}`);
      },
    });

    const result = await tool.execute(
      "call-42",
      { toMemberIds: ["reviewer"], reason: "second pass" },
      undefined,
      undefined,
      forbiddenCtx,
    );

    expect(touched).toEqual([]);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("交接");
    const details = JSON.stringify(result.details);
    expect(details).toContain("reviewer");
    expect(details).toMatch(/platform/);
  });

  it("stays dependency-free so one file serves src, dist and Pi", () => {
    // Comments are stripped: the rule is about the code, and this file's own
    // documentation is allowed to name the things the code must not do.
    const code = readFileSync(handoffExtensionPath(), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\s*\(/);
    for (const forbidden of ["node:child_process", "node:fs", "node:sqlite", "node:http", "fetch("]) {
      expect(code, `extension must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("a missing extension is a hard error, not a silent skip", () => {
  /**
   * This backs `PiAdapter.handoffExtensionFile()`'s claim. Dropping `--extension`
   * quietly would recreate D1 exactly: the run still works, the primary handoff path
   * does not exist, and nothing says so. Measured behaviour of Pi itself, for the same
   * reason: a bogus `--extension` path makes `pi` exit 1 with
   * "Failed to load extension ... does not exist".
   */
  const spec: RunSpec = {
    runId: "missing-ext", tenantId: "t", projectId: "p", memberId: "m",
    workspacePath: tempDir, prompt: "hi",
  };

  it("throws before spawning anything", async () => {
    const spawned: string[][] = [];
    const spawn = ((_command: string, args: string[]) => {
      spawned.push(args);
      return { stdout: { setEncoding: () => {}, on: () => {} }, stdin: { write: () => {} }, kill: () => {}, on: () => {}, exitCode: null, killed: false } as never;
    }) as unknown as typeof import("node:child_process").spawn;

    const adapter = new PiAdapter({
      approveProjectResources: true,
      spawn,
      handoffExtensionPath: join(tempDir, "definitely-not-here.js"),
    });

    await expect(adapter.start(spec)).rejects.toThrow(/handoff_to extension is missing/);
    // Nothing was launched: a half-started Pi with no handoff tool is the defect.
    expect(spawned).toEqual([]);
  });

  it("the explicit opt-out is the only way to skip it", async () => {
    const spawned: string[][] = [];
    const spawn = ((_command: string, args: string[]) => {
      spawned.push(args);
      return { stdout: { setEncoding: () => {}, on: () => {} }, stdin: { write: () => {} }, kill: () => {}, on: () => {}, exitCode: null, killed: false } as never;
    }) as unknown as typeof import("node:child_process").spawn;

    const handle = await new PiAdapter({
      approveProjectResources: true,
      spawn,
      handoffExtension: false,
      handoffExtensionPath: join(tempDir, "definitely-not-here.js"),
    }).start(spec);
    void handle.settled.catch(() => undefined);

    expect(spawned[0]).not.toContain("--extension");
  });
});
