import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pc from "picocolors";

const require = createRequire(import.meta.url);

/**
 * Walk up from `start` until a directory containing `package.json` is found.
 * Falls back to `start` so callers always get a usable directory.
 *
 * Capped at 10 hops so a CLI invoked from a deep path (or the filesystem
 * root) cannot loop forever.
 */
export function resolveProjectRoot(start: string = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export interface DatabasePaths {
  root: string;
  configDir: string;
  schemaFile: string;
  migrationsDir: string;
  baselineFile: string;
}

export function databasePaths(root = resolveProjectRoot()): DatabasePaths {
  const configDir = path.join(root, "config/database");
  return {
    root,
    configDir,
    schemaFile: path.join(configDir, "schema.ts"),
    migrationsDir: path.join(configDir, "migrations"),
    baselineFile: path.join(configDir, "migrations/0000_baseline.json"),
  };
}

export function bullet(text: string): string {
  return `${pc.cyan("[i]")} ${text}`;
}

export function check(text: string): string {
  return `${pc.green("[ok]")} ${text}`;
}

export function warn(text: string): string {
  return `${pc.yellow("[warn]")} ${text}`;
}

export function cross(text: string): string {
  return `${pc.red("[error]")} ${text}`;
}

export function drizzleKitBinPath(): string {
  return path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs");
}

export async function runCommandAction(
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(cross(formatCliError(error)));
    process.exit(1);
  }
}

function formatCliError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const details = [error.message];
  const cause = error.cause;
  if (cause instanceof Error && cause.message !== error.message) {
    details.push(`Caused by: ${cause.message}`);
  } else if (typeof cause === "object" && cause !== null) {
    const causeRecord = cause as {
      code?: unknown;
      detail?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    if (causeRecord.message) details.push(`Caused by: ${causeRecord.message}`);
    if (causeRecord.code) details.push(`Code: ${causeRecord.code}`);
    if (causeRecord.detail) details.push(`Detail: ${causeRecord.detail}`);
    if (causeRecord.hint) details.push(`Hint: ${causeRecord.hint}`);
  }

  const fullMessage = details.join("\n");
  if (/no schema has been selected to create in/i.test(fullMessage)) {
    details.push(
      "The migration connection did not have a target schema selected. AppKit sets the search_path from config/database/schema.ts before running migrations; verify the schema exports defineSchema(...) with one schemaName.",
    );
  } else if (
    /Failed query:\s*CREATE TABLE/i.test(error.message) &&
    /already exists|42P07|duplicate table/i.test(fullMessage)
  ) {
    details.push(
      "This usually means the database already has tables but Drizzle migration metadata is missing. Use a fresh dev database/branch, or drop the existing fixture tables and the drizzle metadata schema before rerunning setup:dev.",
    );
  }

  return details.join("\n");
}

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface IntrospectionResult {
  schemas: string[];
  tables: Array<{
    schema: string;
    name: string;
    columns: unknown[];
    policies: unknown[];
  }>;
}

export interface DriftReport {
  hasDrift: boolean;
  entries: Array<{
    kind: "live-only" | "schema-only" | "type-mismatch";
    message: string;
  }>;
}

interface AppKitModule {
  createLakebasePool: () => LakebasePool;
}

interface AppKitIntrospectorModule {
  introspect: (
    pool: LakebasePool,
    options?: {
      schemas?: string[];
      exclude?: string[];
      readonly?: boolean;
    },
  ) => Promise<IntrospectionResult>;
  renderSchema: (result: IntrospectionResult) => string;
  diffIntrospections: (
    live: IntrospectionResult,
    declared: IntrospectionResult,
  ) => DriftReport;
  schemaToIntrospection: (schema: unknown) => IntrospectionResult;
  isSchema: (value: unknown) => boolean;
  extractSchema: (mod: unknown) => unknown;
}

/**
 * One row returned by `pool.query`.
 *
 * Defaulted to a permissive `Record<string, unknown>` so simple call sites work
 * untyped, but every parameterized call site in the CLI passes a row-shape so
 * we get type checking on `result.rows[0].my_field`.
 */
export interface LakebaseQueryResult<R = Record<string, unknown>> {
  rows: R[];
}

/**
 * Connection checked out via `pool.connect()`.
 *
 * Mirrors the subset of `pg.PoolClient` that the migrate command actually
 * uses: a parameterized query and `release()`. Callers are responsible for
 * releasing the client even on failure.
 */
export interface LakebaseClient {
  query: <R = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<LakebaseQueryResult<R>>;
  release?: () => void;
}

/**
 * Subset of `pg.Pool` the CLI commands rely on.
 *
 * Typed here (instead of importing `pg.Pool` directly) so `packages/shared`
 * does not depend on `pg`. The factory `createLakebasePool` lives in
 * `@databricks/appkit` and returns a real `pg.Pool`, which conforms to this
 * shape structurally.
 */
export interface LakebasePool {
  query: <R = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<LakebaseQueryResult<R>>;
  end: () => Promise<void>;
  connect?: () => Promise<LakebaseClient>;
}

/**
 * Open a Lakebase pool when the env is configured for it. Returns `null`
 * (instead of throwing) so callers can render a contextual error message.
 */
export async function openLakebasePool(): Promise<LakebasePool | null> {
  if (!process.env.PGHOST && !process.env.LAKEBASE_ENDPOINT) return null;
  const appkit = await runtimeImport<AppKitModule>("@databricks/appkit");
  return appkit.createLakebasePool();
}

/**
 * Run `fn` against an open pool, then close the pool.
 *
 * The `pool.end()` call in the cleanup path is allowed to fail silently
 * because (a) we've already returned the meaningful result/error, and
 * (b) bubbling it would mask the real error from `fn`.
 */
export async function withLakebasePool<T>(
  fn: (pool: LakebasePool) => Promise<T>,
): Promise<T> {
  const pool = await openLakebasePool();
  if (!pool) {
    throw new Error("No Lakebase connection. Set LAKEBASE_ENDPOINT or PGHOST.");
  }
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {
      /* swallow: do not mask the original error from fn */
    });
  }
}

export function loadIntrospector(): Promise<AppKitIntrospectorModule> {
  return runtimeImport<AppKitIntrospectorModule>(
    resolveAppKitSourcePath("database/introspector/index.ts") ??
      "@databricks/appkit/database/introspector",
  );
}

interface AppKitDriftHelpModule {
  formatDriftResolution: (opts?: { includeVerify?: boolean }) => string;
}

/**
 * Load the shared drift-resolution help block from `@databricks/appkit` so
 * the CLI and the runtime plugin print the same hint when drift is detected.
 */
export function loadDriftHelp(): Promise<AppKitDriftHelpModule> {
  return runtimeImport<AppKitDriftHelpModule>(
    "@databricks/appkit/database/introspector",
  );
}

export async function loadSchemaFile(schemaFile: string): Promise<unknown> {
  if (!existsSync(schemaFile)) return null;

  // The user's CLI process must have a TS loader available for schema.ts
  // (tsx/ts-node/esbuild-register). The template wires `tsx` as a devDep.
  const mod = await runtimeImport<Record<string, unknown>>(
    pathToFileURL(schemaFile).href,
  );
  const introspector = await loadIntrospector();
  const schema = introspector.extractSchema(mod);
  if (!introspector.isSchema(schema)) {
    throw new Error(
      `Database schema at ${schemaFile} is not valid. Export defineSchema(...) as the default export.`,
    );
  }
  return schema;
}

/**
 * Bypass tsdown's static-analysis of `import()` so the bundler does not try to
 * resolve dynamic specifiers at build time.
 *
 * tsdown rewrites bare `await import(specifier)` calls into static `require`s
 * that are scanned ahead of time, which breaks runtime resolution against the
 * user app's own `node_modules`. Hiding the import behind `new Function`
 * defeats the static analysis and lets the call resolve at runtime, which is
 * what we want for an injected user-side module path.
 */
function runtimeImport<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<T>;
  return importer(specifier);
}

function resolveAppKitSourcePath(relativeSourcePath: string): string | null {
  try {
    const packageJsonPath = require.resolve("@databricks/appkit/package.json");
    const sourcePath = path.join(
      path.dirname(packageJsonPath),
      "src",
      relativeSourcePath,
    );
    return existsSync(sourcePath) ? pathToFileURL(sourcePath).href : null;
  } catch {
    return null;
  }
}
