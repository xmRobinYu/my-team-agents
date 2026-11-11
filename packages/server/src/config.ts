import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ExecutionStore } from "@my-team-agents/orchestrator";

/**
 * D6/A + AC5.3: the event-ingress surface is OFF unless explicitly enabled, and
 * needs a bearer token when one is configured. Both come from the environment and
 * neither is ever written to an event row or a log line.
 *
 * Off by default is the point: this is the first path where external bytes enter
 * the platform, and the PRD's own risk table says so. `enabled` must be the exact
 * string "1" — a typo like "true" leaves it closed rather than guessing.
 */
export function ingestConfig() {
  const token = process.env.MTA_INGEST_TOKEN;
  return {
    enabled: process.env.MTA_INGEST_ENABLED === "1",
    ...(token && token.trim() !== "" ? { token: token.trim() } : {}),
  };
}

export function openExecutionStore() {
  const root = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
  const filename = process.env.MTA_DB_PATH ?? resolve(root, ".mta/execution.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  return { store: new ExecutionStore(filename), filename };
}
