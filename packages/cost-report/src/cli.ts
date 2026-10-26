#!/usr/bin/env node
/**
 * cost-report CLI — the v1 daily self-assessment entry point.
 *
 * Reads Pi session JSONL, aggregates usage by provider/model, prints a report.
 * A `since` cursor file makes repeated daily runs incremental and idempotent.
 */

import { readFile, writeFile } from "node:fs/promises";
import { aggregate, nextCursor, renderReport } from "./aggregate.js";
import { parseSessionFile } from "./parse.js";
import type { Attribution } from "./types.js";

function usage(): string {
  return [
    "cost-report — daily self-assessment from Pi session logs",
    "",
    "Usage:",
    "  cost-report --session <file.jsonl> [--tenant <id>] [--project <id>] [--member <id>]",
    "                [--since-file <path>] [--json]",
    "",
    "Options:",
    "  --session      Pi session JSONL file (repeatable)",
    "  --tenant       attribution: tenant id (default: default)",
    "  --project      attribution: project id (default: default)",
    "  --member       attribution: member id (default: default)",
    "  --since-file   read/write a `since` entry-id cursor at this path",
    "  --json         emit JSON instead of markdown",
    "  -h, --help     show this help",
  ].join("\n");
}

export interface Args {
  sessions: string[];
  attribution: Attribution;
  sinceFile?: string;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    sessions: [],
    attribution: { tenant: "default", project: "default", member: "default" },
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // Call sites do `i += 1` first, so the value is at argv[i].
    const next = () => argv[i];
    switch (a) {
      case "--session":
        i += 1;
        if (next()) args.sessions.push(next() as string);
        break;
      case "--tenant":
        i += 1;
        args.attribution.tenant = next() ?? args.attribution.tenant;
        break;
      case "--project":
        i += 1;
        args.attribution.project = next() ?? args.attribution.project;
        break;
      case "--member":
        i += 1;
        args.attribution.member = next() ?? args.attribution.member;
        break;
      case "--since-file":
        i += 1;
        args.sinceFile = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.sessions.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let since: string | undefined;
  if (args.sinceFile) {
    try {
      since = (await readFile(args.sinceFile, "utf8")).trim() || undefined;
    } catch {
      since = undefined;
    }
  }

  const records = [];
  for (const s of args.sessions) {
    const result = await parseSessionFile(s, since ? { since } : {});
    records.push(...result.records);
  }

  const rows = aggregate(records, args.attribution);

  if (args.sinceFile) {
    const cursor = nextCursor(records, since);
    if (cursor) await writeFile(args.sinceFile, cursor, "utf8");
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ attribution: args.attribution, rows }, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(rows));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`cost-report failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
