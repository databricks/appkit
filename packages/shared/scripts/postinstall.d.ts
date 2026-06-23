// Type declarations for the self-contained postinstall script. The script itself
// (postinstall.js) ships verbatim in the published package; this .d.ts is dev-only
// (not copied by tools/dist-appkit.ts) and exists so the unit test can import the
// script under TypeScript without enabling allowJs.

/**
 * Pre-fetch the @ast-grep/napi native host binding at install time. No-op unless
 * running under npm. Best-effort and NON-FATAL: runs in a child process bounded by
 * a hard timeout, and any failure or timeout logs a single warning and returns.
 */
export function ensureAstGrepBinding(): void;

/** Print the hint telling users how to set up AI assistant instructions. */
export function printSetupHint(): void;
