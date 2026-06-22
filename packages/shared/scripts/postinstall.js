#!/usr/bin/env node
// This script is copied STANDALONE into the published @databricks/appkit package
// (see tools/dist-appkit.ts). It must stay SELF-CONTAINED: it may only import
// external runtime deps (declared in packages/shared/package.json -> dependencies)
// and must NEVER import from appkit's own src/dist — those paths do not exist in
// the published layout.
import { fileURLToPath } from "node:url";

/**
 * Pre-fetch the @ast-grep/napi native host binding at install time.
 *
 * `appkit generate-types` loads @ast-grep/napi, which resolves a platform-specific
 * optional dependency (e.g. @ast-grep/napi-linux-x64-gnu). npm sometimes silently
 * skips that optional binary (npm/cli#4828, or a supply-chain cutoff), which makes
 * the binding fail to load at runtime and crashes the app's own postinstall on
 * Databricks Apps. `napi-postinstall` re-resolves and materializes the correct
 * native package so the binding is guaranteed present.
 *
 * This is a best-effort, NON-FATAL step:
 *   - It only runs under npm (the package manager with the optional-dep bug). Under
 *     pnpm/yarn-PnP the approach does not apply, so it is a no-op.
 *   - Any failure prints a single concise warning and resolves normally. A failed
 *     pre-fetch must NEVER break `npm install`.
 */
export async function ensureAstGrepBinding() {
  // Only npm exhibits the optional-dependency skip this works around. Other package
  // managers (pnpm, yarn PnP) either resolve correctly or don't support this flow.
  if (!process.env.npm_config_user_agent?.startsWith("npm/")) {
    return;
  }

  try {
    // napi-postinstall is CommonJS; this script is ESM, so load it via dynamic import.
    const { checkAndPreparePackage } = await import("napi-postinstall");
    await checkAndPreparePackage("@ast-grep/napi");
  } catch (err) {
    // Non-fatal: never throw, never exit non-zero. console.error writes to stderr.
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
  await ensureAstGrepBinding();
  printSetupHint();
}
