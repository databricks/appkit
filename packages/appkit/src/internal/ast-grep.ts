import { createRequire } from "node:module";

/**
 * Lazy, memoized loader for `@ast-grep/napi` (appkit side).
 *
 * See `packages/shared/src/cli/ast-grep.ts` for the full rationale on why this is
 * loaded lazily via `require` rather than a top-level `import` (the native binary
 * ships as an optionalDependency and can be absent on a remote-install that omits
 * optional deps, in which case `require` throws `MODULE_NOT_FOUND`).
 *
 * In appkit, ast-grep only powers optional conveniences — serving-endpoint type
 * auto-discovery and the dev-only source-location Vite plugin — so every caller
 * DEGRADES (skips the feature) when the native binary is unavailable rather than
 * failing. That keeps importing the `@databricks/appkit` barrel and booting a
 * server safe even when the platform binary was never materialized, regardless of
 * how the production server bundle is built.
 *
 * `createRequire` keeps the call sites synchronous (e.g. the sync serving
 * extractor and the sync Vite `transform` hook).
 */
const _require = createRequire(import.meta.url);

let cached: typeof import("@ast-grep/napi") | null | undefined;

/**
 * Load `@ast-grep/napi`, or return `null` if its native binary is unavailable on
 * this platform. The underlying `require` runs at most once (memoized).
 */
export function tryLoadAstGrep(): typeof import("@ast-grep/napi") | null {
  if (cached !== undefined) return cached;
  let mod: typeof import("@ast-grep/napi") | null;
  try {
    mod = _require("@ast-grep/napi");
  } catch {
    mod = null;
  }
  cached = mod;
  return mod;
}
