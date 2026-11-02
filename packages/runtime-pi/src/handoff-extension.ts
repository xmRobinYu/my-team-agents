/**
 * Locating the `handoff_to` Pi extension — D1 (P8/I10).
 *
 * The extension has to reach every Pi run, so its path is derived from the URL of
 * the module that asks for it, never from `process.cwd()` (for a Pi run the cwd IS
 * the persona dir, see `RunSpec.agentDir`) and never from Pi's resource discovery
 * (project paths are trust-gated, and a persona dir is not a discovery root at
 * all — that is exactly the mistake I9 made with skills, `./skills.ts`).
 *
 * Why ONE on-disk file serves both ways of running this package: the extension
 * lives in `pi-extensions/`, OUTSIDE `src/`, which is the whole of the package's
 * `tsc` input (`rootDir: src`, `include: src` types only) — so the compiler neither
 * reads, transforms, nor copies it, and no second copy can appear under `dist/`.
 * Both `src/adapter.ts` and `dist/adapter.js` sit exactly one level below the
 * package root, so `../pi-extensions/handoff-to.js` resolves to the same file from
 * either. `handoffExtensionPath()` is pure over a module URL precisely so that claim
 * can be asserted without building anything: vitest goes through the `src` alias,
 * production goes through `dist`.
 *
 * Loading is by explicit `--extension <path>`: `pi --help` documents
 * `--no-extensions` as "Disable extension discovery and built-in extensions
 * (explicit -e paths still work)", so an explicit path is the only form that
 * survives both a discovery shutdown and a declined project trust.
 */

import { fileURLToPath } from "node:url";

/** Directory of the shipped Pi extensions, relative to the package root. */
export const PI_EXTENSIONS_DIR_NAME = "pi-extensions";

/** File name of the handoff extension inside `pi-extensions/`. */
export const HANDOFF_EXTENSION_FILE_NAME = "handoff-to.js";

/**
 * Absolute path of the handoff extension as seen from `moduleUrl`. Pure: touches
 * no filesystem, so the src and dist resolutions can be compared directly.
 */
export function handoffExtensionPath(moduleUrl: string | URL = import.meta.url): string {
  const specifier = `../${PI_EXTENSIONS_DIR_NAME}/${HANDOFF_EXTENSION_FILE_NAME}`;
  return fileURLToPath(new URL(specifier, moduleUrl));
}

/**
 * argv fragment that hands the extension to Pi. Empty when disabled, so a caller
 * that opts out (or an adapter test that pins byte-identical args) is unchanged.
 */
export function handoffExtensionArgs(moduleUrl: string | URL = import.meta.url): string[] {
  return ["--extension", handoffExtensionPath(moduleUrl)];
}
