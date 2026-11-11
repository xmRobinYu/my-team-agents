import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ExecutionStore } from "@my-team-agents/orchestrator";

/**
 * A static bearer token below this length is not a secret, it is a formality: 24
 * chars is the floor a 15-char `/dev/urandom | base64` slice still clears, while
 * `token=1` and `MTA_INGEST_TOKEN=dev` are refused. Refusing is the point — a weak
 * token on the first inbound surface is worse than no surface, because it looks
 * guarded.
 */
export const MIN_TOKEN_LENGTH = 24;

/**
 * Why the ingest surface is (not) open. A reason is not decoration: the previous
 * contract was "no token configured => loopback only, no auth", so an operator who
 * set `MTA_INGEST_ENABLED=1` and forgot the token got an OPEN endpoint and no
 * signal. "Enabled without a token" now closes the door and says which variable is
 * missing, from `/api/health`, in one request.
 */
export type IngestClosedReason =
  | "DISABLED"          // MTA_INGEST_ENABLED is not "1"
  | "TOKEN_REQUIRED"    // enabled, but no MTA_INGEST_TOKEN
  | "TOKEN_TOO_SHORT";  // enabled, token present but below MIN_TOKEN_LENGTH

export interface IngestConfig {
  /** `MTA_INGEST_ENABLED === "1"`. Off by default (D6/A). */
  enabled: boolean;
  /** True only when the routes are actually registered. */
  open: boolean;
  /** Present only for a token at or above MIN_TOKEN_LENGTH. */
  token?: string;
  /** AC5.3 escape hatch: `MTA_INGEST_ALLOW_ANON=1` opens it with no token. */
  allowAnon: boolean;
  /**
   * P9e: the source to assume for a producer that names none. AIHOT's `wakeAgent`
   * posts `{id,type,subject,summary,detail,link}` with NO `source` field at all, so
   * a deployment fronting it must name the source here or every alert is a 400.
   */
  defaultSource?: string;
  reason?: IngestClosedReason;
}

/**
 * D6/A + AC5.3, hardened: the event-ingress surface is OFF unless explicitly
 * enabled, and an enabled surface is CLOSED unless it carries a usable token or the
 * operator has explicitly opted into anonymous access. Both come from the
 * environment and neither is ever written to an event row or a log line.
 *
 * `enabled` must be the exact string "1" — a typo like "true" leaves it closed
 * rather than guessing.
 */
export function ingestConfig(): IngestConfig {
  const enabled = process.env.MTA_INGEST_ENABLED === "1";
  const allowAnon = process.env.MTA_INGEST_ALLOW_ANON === "1";
  const raw = process.env.MTA_INGEST_TOKEN?.trim() ?? "";
  const longEnough = raw.length >= MIN_TOKEN_LENGTH;

  const defaultSource = process.env.MTA_INGEST_SOURCE?.trim() ?? "";
  const withSource = <T extends IngestConfig>(c: T): T =>
    defaultSource === "" ? c : { ...c, defaultSource };

  if (!enabled) return withSource({ enabled, open: false, allowAnon, reason: "DISABLED" as IngestClosedReason });
  if (longEnough) return withSource({ enabled, open: true, token: raw, allowAnon });
  // A short token is NOT silently downgraded to anonymous: that would turn a
  // misconfiguration into an open endpoint. It closes the surface instead.
  if (raw !== "" && !allowAnon) return withSource({ enabled, open: false, allowAnon, reason: "TOKEN_TOO_SHORT" });
  if (allowAnon) return withSource({ enabled, open: true, allowAnon });
  return withSource({ enabled, open: false, allowAnon, reason: "TOKEN_REQUIRED" });
}

export function openExecutionStore() {
  const root = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
  const filename = process.env.MTA_DB_PATH ?? resolve(root, ".mta/execution.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  return { store: new ExecutionStore(filename), filename };
}
