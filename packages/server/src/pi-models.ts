/**
 * Model catalog for `GET /api/pi/models` (the react-pi `PiClient` endpoint the
 * P7a projection never served).
 *
 * Where a real Pi install keeps its models: `<agent-dir>/models.json`, with
 * `<agent-dir>` defaulting to `~/.pi/agent` and overridable by
 * `PI_CODING_AGENT_DIR` (verified in the upstream package docs,
 * `docs/configuration.md:3-16` and `docs/models-configuration.md:9-33`). The
 * react-pi node supervisor reads exactly that file
 * (`node/ThreadSupervisor.ts:430-437`), so this is the same source of truth —
 * we are not inventing a second catalog.
 *
 * Honest degradation, in order:
 *  - No file / unreadable / malformed → an empty list. `createPiHttpClient`
 *    accepts `[]` (only a non-array throws, `httpClient.ts:144-157`), and an
 *    empty catalog is the truthful answer when there is no Pi install; a 500
 *    would be worse — the HTTP client turns any non-2xx into a thrown error the
 *    UI has to handle anyway.
 *  - Models our own records mention but that cannot be attributed to a provider
 *    are NOT invented. `PiModelInfo.provider` is required and non-empty, so a
 *    bare `model` string with no provider would have to be guessed, and a wrong
 *    guess would show the user a selectable model that does not exist.
 *
 * Only whitelisted fields are read (provider `name`, model `id`/`name`/
 * `reasoning`). `apiKey`, `headers`, `authHeader` and everything else in that
 * file are credential-adjacent and are never echoed; `auth.json` is never
 * opened at all (AGENTS.md: keep provider credentials private).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `PiModelInfo` is a plain serializable shape; re-declared so this module has
 * no dependency on a browser-facing package. */
export interface ModelInfo {
  provider: string;
  modelId: string;
  name?: string;
  supportsThinking?: boolean;
  availableThinkingLevels?: readonly string[];
}

interface JsonRecord {
  [key: string]: unknown;
}

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** Default agent dir, following Pi's own resolution order. */
export const piAgentDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = nonEmpty(env.PI_CODING_AGENT_DIR);
  return override ?? join(homedir(), ".pi", "agent");
};

/**
 * Parse `models.json` into catalog entries. Any problem yields `[]` — the file
 * is optional by design, and an unreadable catalog must not break the API.
 */
export function readModelCatalog(path: string): ModelInfo[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const providers = record(record(parsed)?.providers);
  if (!providers) return [];
  const models: ModelInfo[] = [];
  for (const [providerId, raw] of Object.entries(providers)) {
    const provider = record(raw);
    const entries = Array.isArray(provider?.models) ? provider.models : [];
    for (const rawModel of entries) {
      const model = record(rawModel);
      const modelId = nonEmpty(model?.id);
      if (!modelId) continue;
      const name = nonEmpty(model?.name);
      const supportsThinking = typeof model?.reasoning === "boolean" ? model.reasoning : undefined;
      models.push({
        provider: providerId,
        modelId,
        ...(name ? { name } : {}),
        ...(supportsThinking !== undefined ? { supportsThinking } : {}),
      });
    }
  }
  return models;
}

/**
 * A model string as our records store it. `TaskRecord.model` reaches Pi as
 * `--model`, which accepts `provider/model` as well as a bare id/pattern
 * (`runtime-pi/src/adapter.ts:221`), so attribution is only possible for the
 * qualified form or an id already present in the catalog.
 */
export function attributeModel(
  value: string | null | undefined,
  catalog: readonly ModelInfo[],
): ModelInfo | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const provider = raw.slice(0, slash);
    const modelId = raw.slice(slash + 1);
    return catalog.find((m) => m.provider === provider && m.modelId === modelId)
      ?? { provider, modelId };
  }
  return catalog.find((m) => m.modelId === raw) ?? null;
}

/** Catalog plus every model our own records reference, deduplicated. */
export function mergeModels(
  catalog: readonly ModelInfo[],
  observed: readonly (string | null | undefined)[],
): ModelInfo[] {
  const out: ModelInfo[] = [...catalog];
  const seen = new Set(catalog.map((m) => `${m.provider}/${m.modelId}`));
  for (const value of observed) {
    const model = attributeModel(value, catalog);
    if (!model) continue;
    const key = `${model.provider}/${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}
