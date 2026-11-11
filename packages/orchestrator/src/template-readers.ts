/**
 * Zip and JSON readers for template packages.
 *
 * Split out of `template-import.ts`. The rule this file encodes: a REQUIRED file
 * that is missing or malformed throws a named `TemplateImportError`, while an
 * OPTIONAL side file degrades to a warning — I2 says "解析不了就记警告，不要崩",
 * and a room is still importable without skills or capability descriptors.
 */

import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { TemplateImportError } from "./template-types.js";
import type { ImportWarning, ZipSource } from "./template-types.js";

export const decoder = /* @__PURE__ */ new TextDecoder("utf-8");

export const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/** Compact rendering of a discarded value; empty/false-y noise returns undefined. */
export const preview = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "false" || trimmed === "[]" || trimmed === "{}" || trimmed === "null") {
    return undefined;
  }
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

export const unpack = (source: ZipSource): Record<string, Uint8Array> => {
  let bytes: Uint8Array;
  if (typeof source === "string") {
    try {
      bytes = new Uint8Array(readFileSync(source));
    } catch (err) {
      throw new TemplateImportError("ZIP_UNREADABLE", `模板包无法读取：${source} — ${msg(err)}`, source);
    }
  } else {
    bytes = source;
  }
  if (bytes.length < 4) throw new TemplateImportError("ZIP_INVALID", "内容太短，不是 zip 包");
  try {
    return unzipSync(bytes);
  } catch (err) {
    throw new TemplateImportError("ZIP_INVALID", `不是可解析的 zip：${msg(err)}`);
  }
};

export const entryText = (entries: Record<string, Uint8Array>, name: string): string | undefined => {
  const hit = entries[name];
  return hit === undefined ? undefined : decoder.decode(hit);
};

export const readRequiredJson = (entries: Record<string, Uint8Array>, file: string): unknown => {
  const raw = entryText(entries, file);
  if (raw === undefined) throw new TemplateImportError("FILE_MISSING", `模板包缺少 ${file}`, file);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new TemplateImportError("JSON_INVALID", `${file} 不是合法 JSON：${msg(err)}`, file);
  }
};

/**
 * Optional side file. A missing or unparsable one is a warning, not a crash:
 * skills and capability descriptors enrich the import but a room without them
 * is still importable — I2 says "解析不了就记警告，不要崩".
 */
export const readOptionalJsonArray = (
  entries: Record<string, Uint8Array>,
  file: string,
  warnings: ImportWarning[],
): unknown[] | undefined => {
  const raw = entryText(entries, file);
  if (raw === undefined) {
    warnings.push({ code: "file-missing", message: `包内没有 ${file}，相关信息按缺省处理` });
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      warnings.push({ code: "file-shape-unexpected", message: `${file} 顶层不是数组，已忽略` });
      return undefined;
    }
    return parsed;
  } catch (err) {
    warnings.push({ code: "file-invalid-json", message: `${file} 解析失败，已忽略：${msg(err)}` });
    return undefined;
  }
};
