import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Schema } from "../../database";
import { ConfigurationError } from "../../errors";

/**
 * Convention paths for loading the database schema.
 */
const CONVENTION_PATHS = [
  "config/database/schema.ts",
  "config/database/schema/index.ts",
  "dist/config/database/schema.js",
  "dist/config/database/schema/index.js",
] as const;

/**
 * Result of loading the database schema by convention.
 */
interface LoadSchemaResult {
  schema: Schema;
  schemaPath: string;
}

/**
 * Options for loading the database schema by convention.
 */
interface LoadSchemaByConventionOptions {
  /** The current working directory. */
  cwd?: string;
  /** A function to import the schema module. */
  importer?: (absolutePath: string) => Promise<unknown>;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    "$drizzle" in value &&
    "$tables" in value &&
    typeof (value as { $tables?: unknown }).$tables === "object"
  );
}

export async function loadSchemaByConvention(
  options: LoadSchemaByConventionOptions = {},
): Promise<LoadSchemaResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const importer = options.importer ?? defaultImporter;

  for (const candidate of CONVENTION_PATHS) {
    const absolutePath = path.resolve(cwd, candidate);
    if (!(await pathExists(absolutePath))) continue;

    const mod = await importer(absolutePath);
    const schema = extractSchema(mod);

    if (!isSchema(schema)) {
      throw new ConfigurationError(
        `Database schema at ${absolutePath} is not a valid AppKit schema. Export the result of defineSchema(...) as the default export.`,
        { context: { schemaPath: absolutePath } },
      );
    }

    return { schema, schemaPath: absolutePath };
  }

  return null;
}

async function defaultImporter(absolutePath: string): Promise<unknown> {
  return import(pathToFileURL(absolutePath).href);
}

function extractSchema(mod: unknown): unknown {
  if (isSchema(mod)) return mod;
  if (typeof mod !== "object" || mod === null) return undefined;

  const exports = mod as { default?: unknown; schema?: unknown };
  return exports.default ?? exports.schema;
}
