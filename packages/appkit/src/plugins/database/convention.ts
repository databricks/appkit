import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Schema } from "../../database";
import { extractSchema } from "../../database/introspector/schema-loader";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";

const logger = createLogger("database:convention");

export { isSchema } from "../../database/introspector/schema-loader";

/**
 * Convention paths for loading the database schema.
 *
 * Order matters: dev `.ts` paths win over prod `dist/.../*.js` because in dev
 * mode both can be present after a recent build, and we always prefer the
 * source the user is actively editing.
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

export async function loadSchemaByConvention(
  options: LoadSchemaByConventionOptions = {},
): Promise<LoadSchemaResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const importer = options.importer ?? defaultImporter;

  const probed: string[] = [];
  for (const candidate of CONVENTION_PATHS) {
    const absolutePath = path.resolve(cwd, candidate);
    probed.push(absolutePath);
    if (!(await pathExists(absolutePath))) continue;

    const mod = await importer(absolutePath);
    const schema = extractSchema(mod);

    if (!schema) {
      throw new ConfigurationError(
        `Database schema at ${absolutePath} is not a valid AppKit schema. Export the result of defineSchema(...) as the default export.`,
        { context: { schemaPath: absolutePath } },
      );
    }

    return { schema, schemaPath: absolutePath };
  }

  logger.info(
    "No database schema found. Probed paths:\n  - %s",
    probed.join("\n  - "),
  );
  return null;
}

async function defaultImporter(absolutePath: string): Promise<unknown> {
  return import(pathToFileURL(absolutePath).href);
}
