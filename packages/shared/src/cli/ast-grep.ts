import { createRequire } from "node:module";

/**
 * Lazy, memoized loader for `@ast-grep/napi` (shared CLI side).
 *
 * `@ast-grep/napi` is a native (N-API) module whose platform binary ships as an
 * optionalDependency (`@ast-grep/napi-<platform>`). When that binary is not
 * materialized — e.g. a Databricks Apps remote-install that omits optional
 * dependencies — the parent package's `index.js` throws `MODULE_NOT_FOUND` the
 * moment it is `require`d. A top-level static import of the package therefore
 * crashes the whole CLI during module evaluation, before any command action can
 * run (which is why a command-level try/catch never fires — you get a raw stack).
 *
 * Loading it lazily through `require` instead (a) keeps it off the module-eval
 * path, so merely loading the CLI never touches the native binary, and (b) lets
 * us catch a missing binary and turn it into either a graceful degrade
 * ({@link tryLoadAstGrep}) or a clear, actionable error
 * ({@link loadAstGrepOrThrow}) rather than an opaque stack trace.
 *
 * `createRequire` (rather than dynamic `await import()`) is deliberate: it keeps
 * the call sites synchronous, so the sync parse-using functions stay sync with no
 * async-propagation refactor.
 */
const _require = createRequire(import.meta.url);

let cached: typeof import("@ast-grep/napi") | null | undefined;

/**
 * Thrown when `@ast-grep/napi`'s native binary is unavailable and the caller
 * requires it. Carries an actionable message; CLI commands catch this to print
 * the message (not a raw `MODULE_NOT_FOUND` stack) and exit non-zero.
 */
export class AstGrepUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstGrepUnavailableError";
  }
}

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

/**
 * Load `@ast-grep/napi`, or throw an {@link AstGrepUnavailableError} with an
 * actionable message. Use from commands that cannot function without it
 * (`lint`, `plugin sync`, `codemod`).
 */
export function loadAstGrepOrThrow(): typeof import("@ast-grep/napi") {
  const mod = tryLoadAstGrep();
  if (!mod) {
    throw new AstGrepUnavailableError(
      "@ast-grep/napi's native binary is unavailable for this platform " +
        `(${process.platform}-${process.arch}). Reinstall with optional ` +
        "dependencies enabled (e.g. `npm install --include=optional`) so the " +
        "platform package (@ast-grep/napi-<platform>) is materialized.",
    );
  }
  return mod;
}
