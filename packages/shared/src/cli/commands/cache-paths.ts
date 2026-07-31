import path from "node:path";

/**
 * Home for typegen COMMITTED caches (build inputs that must survive `pnpm
 * install` and travel with the app in git). Per-app, anchored at the app root.
 * The two caches (query/metric + serving) live here as `.appkit/*.json`.
 *
 * @param rootDir - project root. Defaults to the current working directory.
 * @returns absolute path to the committed cache directory.
 */
export function getCommittedCacheDir(rootDir: string = process.cwd()): string {
  return path.join(rootDir, ".appkit");
}

/**
 * Home for typegen EPHEMERAL coordination state (worker spawn lock, ui-variant
 * choices). Stays under `node_modules/` — gitignored, cleared on clean install.
 * Never committed.
 *
 * @param rootDir - project root. Defaults to the current working directory.
 * @returns absolute path to the ephemeral state directory.
 */
export function getEphemeralStateDir(rootDir: string = process.cwd()): string {
  return path.join(rootDir, "node_modules", ".databricks", "appkit");
}
