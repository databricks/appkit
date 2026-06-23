#!/usr/bin/env node
// This script is copied STANDALONE into the published @databricks/appkit package
// (see tools/dist-appkit.ts). It must stay SELF-CONTAINED: it may only import
// external runtime deps (declared in packages/shared/package.json -> dependencies)
// and must NEVER import from appkit's own src/dist — those paths do not exist in
// the published layout.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Hard ceiling (ms) on the best-effort native-binding pre-fetch. napi-postinstall
// shells out to a SYNCHRONOUS `npm install` internally, which an in-process timer
// could not interrupt — so the pre-fetch runs in a child process that we kill if it
// exceeds this deadline. A timeout (like any other failure) is non-fatal: a still-
// missing binding is handled gracefully by AppKit's lazy @ast-grep/napi loader.
const PREFETCH_TIMEOUT_MS = 60_000;

// Runs in the child: re-resolve and materialize the @ast-grep/napi host binding.
// `.catch(exit 1)` keeps the child quiet and turns a rejection into a non-zero exit
// that the parent treats as a failed (non-fatal) pre-fetch.
const PREFETCH_SCRIPT =
  "Promise.resolve(require('napi-postinstall').checkAndPreparePackage('@ast-grep/napi')).catch(() => process.exit(1))";

/**
 * Pre-fetch the @ast-grep/napi native host binding at install time.
 *
 * `appkit generate-types` loads @ast-grep/napi, which resolves a platform-specific
 * optional dependency (e.g. @ast-grep/napi-linux-x64-gnu). npm sometimes silently
 * skips that optional binary (npm/cli#4828, or a supply-chain cutoff), which makes
 * the binding fail to load and crashes the app's own postinstall on Databricks Apps.
 * `napi-postinstall` re-resolves and materializes the correct native package.
 *
 * Best-effort and NON-FATAL:
 *   - Runs only under npm (the package manager with the optional-dep bug). Under
 *     pnpm/yarn-PnP the approach does not apply, so it is a no-op.
 *   - Runs in a child process bounded by PREFETCH_TIMEOUT_MS, so a hung/slow fetch
 *     is killed rather than blocking `npm install` indefinitely (napi-postinstall's
 *     internal `npm install` is synchronous, so an in-process timer cannot bound it).
 *   - Any failure or timeout prints a single warning and returns normally. A failed
 *     pre-fetch must NEVER break `npm install`.
 */
export function ensureAstGrepBinding() {
  // Only npm exhibits the optional-dependency skip this works around. Other package
  // managers (pnpm, yarn PnP) either resolve correctly or don't support this flow.
  if (!process.env.npm_config_user_agent?.startsWith("npm/")) {
    return;
  }

  // Package root (…/scripts/postinstall.js -> package dir) so the child resolves
  // `napi-postinstall` and `@ast-grep/napi` from the installed node_modules tree.
  const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  try {
    execFileSync(process.execPath, ["-e", PREFETCH_SCRIPT], {
      cwd: pkgDir,
      stdio: "inherit",
      timeout: PREFETCH_TIMEOUT_MS,
    });
  } catch (err) {
    // Non-fatal: execFileSync throws on a non-zero child exit AND on a timeout kill.
    // console.error writes to stderr.
    console.error(
      `[@databricks/appkit] Could not pre-fetch @ast-grep/napi native binding: ${err?.message ?? err}`,
    );
  }
}

/** Print the hint telling users how to set up AI assistant instructions. */
export function printSetupHint() {
  console.log("");
  console.log("[@databricks/appkit] To setup AI assistant instructions, run:");
  console.log("");
  console.log("  npx appkit setup --write");
  console.log("");
}

// Only run side effects when executed directly (e.g. as the package postinstall),
// not when imported from a test.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureAstGrepBinding();
  printSetupHint();
}
