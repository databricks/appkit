import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * `@databricks/appkit/tsdown` — the server build preset.
 *
 * A scaffolded app's `tsdown.server.config.ts` is a single line:
 *
 * ```ts
 * import { appkitServerConfig } from "@databricks/appkit/tsdown";
 * export default appkitServerConfig();
 * ```
 *
 * so the agent and database discovery wiring lives in the package and reaches existing
 * apps on upgrade, instead of being hand-maintained in every scaffold. The
 * returned object is a plain tsdown config (no `defineConfig` wrapper needed).
 *
 * This module is intentionally dependency-free (only `node:` builtins) — it is
 * loaded at build time and must not pull in the runtime SDK.
 */

/** The tsdown options this preset sets. A structural subset of tsdown's config. */
export interface ServerBuildConfig {
  entry?: string | string[];
  unbundle?: boolean;
  clean?: boolean;
  external?: (id: string) => boolean;
  outExtensions?: () => { js: string };
  tsconfig?: string;
  /** Any other tsdown option passes through untouched. */
  [key: string]: unknown;
}

/**
 * Overrides accepted by {@link appkitServerConfig}: either a partial config
 * (merged — `entry` is unioned, `external` composed, other keys win) or a
 * function that receives AppKit's computed base config for full control.
 */
export type ServerConfigOverrides =
  | ServerBuildConfig
  | ((base: ServerBuildConfig) => ServerBuildConfig);

const SERVER_ENTRY = "server/server.ts";
const AGENT_ENTRY = "server/agents/*/agent.ts";
const DATABASE_ENTRY = "server/database/routes.gen.ts";

function hasDatabaseRoutes(cwd: string): boolean {
  if (existsSync(path.join(cwd, DATABASE_ENTRY))) return true;
  if (existsSync(path.join(cwd, "server/database/routes"))) {
    throw new Error(
      `Run appkit generate-types before building: ${DATABASE_ENTRY} is missing.`,
    );
  }
  return false;
}

/** AppKit default: keep anything resolving outside the project out of the bundle. */
const defaultExternal = (id: string): boolean =>
  /^[^./]/.test(id) || id.includes("/node_modules/");

function toEntryArray(entry: string | string[] | undefined): string[] {
  if (entry === undefined) return [];
  return Array.isArray(entry) ? entry : [entry];
}

/** True when `server/agents/` holds at least one `<id>/agent.ts` (a code agent). */
function hasCodeAgents(cwd: string): boolean {
  const root = path.join(cwd, "server", "agents");
  try {
    return readdirSync(root, { withFileTypes: true }).some((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      try {
        return readdirSync(path.join(root, e.name)).includes("agent.ts");
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Include discovered modules and remove stale output when sources are deleted. */
function baseConfig(
  codeAgents: boolean,
  databaseRoutes: boolean,
): ServerBuildConfig {
  return {
    entry: [
      SERVER_ENTRY,
      ...(codeAgents ? [AGENT_ENTRY] : []),
      ...(databaseRoutes ? [DATABASE_ENTRY] : []),
    ],
    unbundle: true,
    clean: true,
    external: defaultExternal,
    outExtensions: () => ({ js: ".js" }),
  };
}

/**
 * The server tsdown config, merging AppKit's required wiring with `overrides`.
 *
 * Object overrides merge with intent, not a blind spread:
 *   - `entry` is UNIONed — the agent glob can't be dropped by an override;
 *   - `external` is COMPOSED — the caller's predicate runs alongside AppKit's;
 *   - every other key wins.
 * A function override instead receives the computed base and returns the final
 * config, for callers that need full control (including removing the glob).
 *
 * Agent and database entries are included when their conventions exist.
 * The output is cleaned so deleting a route also removes its compiled registry.
 * Pass `opts.codeAgents` to override agent detection (e.g. a non-standard layout).
 */
export function appkitServerConfig(
  overrides: ServerConfigOverrides = {},
  opts: { cwd?: string; codeAgents?: boolean } = {},
): ServerBuildConfig {
  const cwd = opts.cwd ?? process.cwd();
  const codeAgents = opts.codeAgents ?? hasCodeAgents(cwd);
  const base = baseConfig(codeAgents, hasDatabaseRoutes(cwd));

  if (typeof overrides === "function") return overrides(base);

  const baseEntries = toEntryArray(base.entry);
  const entry = [
    ...baseEntries,
    ...toEntryArray(overrides.entry).filter((e) => !baseEntries.includes(e)),
  ];

  const userExternal = overrides.external;
  const external = userExternal
    ? (id: string): boolean => defaultExternal(id) || userExternal(id)
    : defaultExternal;

  return { ...base, ...overrides, entry, external };
}
