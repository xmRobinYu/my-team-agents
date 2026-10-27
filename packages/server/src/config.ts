import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ExecutionStore } from "@my-team-agents/orchestrator";

export function openExecutionStore() {
  const root = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
  const filename = process.env.MTA_DB_PATH ?? resolve(root, ".mta/execution.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  return { store: new ExecutionStore(filename), filename };
}
