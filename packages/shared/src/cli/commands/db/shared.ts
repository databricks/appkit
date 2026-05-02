import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pc from "picocolors";

/**
 * Walk up from cwd until we find the app root.
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
}

export interface LakebasePool {
  query: (sql: string) => Promise<unknown>;
  end: () => Promise<void>;
}

export async function openLakebasePool(): Promise<LakebasePool | null> {
  if (!process.env.PGHOST && !process.env.LAKEBASE_ENDPOINT) return null;
  const appkit = await runtimeImport<AppKitModule>("@databricks/appkit");
  return appkit.createLakebasePool();
}

export function loadIntrospector(): Promise<AppKitIntrospectorModule> {
  return runtimeImport<AppKitIntrospectorModule>(
    "@databricks/appkit/database/introspector",
  );
}

export async function loadSchemaFile(schemaFile: string): Promise<unknown> {
  if (!existsSync(schemaFile)) return null;

  // This expects the user's CLI process to have a TS loader available for
  // schema.ts, which matches the database plugin's local development path.
  const mod = await runtimeImport<Record<string, unknown>>(
    pathToFileURL(schemaFile).href,
  );
  const schema = extractSchema(mod);
  if (!isSchema(schema)) {
    throw new Error(
      `Database schema at ${schemaFile} is not valid. Export defineSchema(...) as the default export.`,
    );
  }
  return schema;
}

function extractSchema(mod: unknown): unknown {
  let current = mod;
  for (let i = 0; i < 3; i++) {
    if (isSchema(current)) return current;
    if (typeof current !== "object" || current === null) return undefined;

    const exports = current as { default?: unknown; schema?: unknown };
    current = exports.schema ?? exports.default;
  }
  return isSchema(current) ? current : undefined;
}

function isSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "$tables" in value &&
    typeof (value as { $tables?: unknown }).$tables === "object"
  );
}

function runtimeImport<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<T>;
  return importer(specifier);
}
