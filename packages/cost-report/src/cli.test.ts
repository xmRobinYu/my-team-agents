import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("reads the value that follows each flag (regression: off-by-one skipped the value)", () => {
    const args = parseArgs(["--session", "a.jsonl", "--tenant", "t1", "--project", "p1", "--member", "m1"]);
    expect(args.sessions).toEqual(["a.jsonl"]);
    expect(args.attribution).toEqual({ tenant: "t1", project: "p1", member: "m1" });
  });

  it("supports repeated --session flags", () => {
    const args = parseArgs(["--session", "a.jsonl", "--session", "b.jsonl"]);
    expect(args.sessions).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("parses since-file and json without consuming the wrong token", () => {
    const args = parseArgs(["--session", "a.jsonl", "--since-file", ".cursor", "--json"]);
    expect(args.sinceFile).toBe(".cursor");
    expect(args.json).toBe(true);
    expect(args.sessions).toEqual(["a.jsonl"]);
  });

  it("defaults attribution when flags are absent", () => {
    const args = parseArgs(["--session", "a.jsonl"]);
    expect(args.attribution).toEqual({ tenant: "default", project: "default", member: "default" });
    expect(args.help).toBe(false);
  });
});
