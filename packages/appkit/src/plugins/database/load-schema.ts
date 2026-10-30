import { stat } from "node:fs/promises";
import path from "node:path";

import { databaseSetupFailed } from "../../database/errors";
import type { Schema } from "../../database/schema-builder";
import { assertFinalizedSchema } from "../../database/schema-builder/define-schema";

/** Same application-relative convention used by appkit generate-types. */
export const DEFAULT_SCHEMA_FILE = "config/database/schema.ts";

interface LoadSchemaOptions {
  /** Report why the module failed to import. Only for local CLI runs: see the catch below. */
  readonly showImportError?: boolean;
}

/** Load application-owned declarations during setup, never during registration. */
export async function loadDefaultDatabaseSchema(
  root = process.cwd(),
  options: LoadSchemaOptions = {},
): Promise<Schema> {
  const file = path.resolve(root, DEFAULT_SCHEMA_FILE);
  const label = JSON.stringify(file);
  let isFile: boolean;
  try {
    isFile = (await stat(file)).isFile();
  } catch {
    throw databaseSetupFailed(
      `Cannot read the default schema at ${label}. Create ${DEFAULT_SCHEMA_FILE} with a named "schema" export, or pass database({ schema }). The path is relative to the application's working directory.`,
    );
  }
  if (!isFile) {
    throw databaseSetupFailed(`The default schema at ${label} must be a file.`);
  }

  let module: unknown;
  try {
    // Jiti also loads TypeScript declarations in a plain Node production run.
    // No module cache: a fresh plugin instance must not inherit a stale schema.
    const { createJiti } = await import("jiti");
    module = await createJiti(import.meta.url, { moduleCache: false }).import(
      file,
    );
  } catch (error) {
    // Import errors can contain credentials, row values, or application internals.
    // A CLI run shows them to the developer who wrote the file; the runtime never does.
    if (options.showImportError) {
      throw new Error(`Could not load ${DEFAULT_SCHEMA_FILE}.`, {
        cause: error,
      });
    }
    throw databaseSetupFailed(
      `Could not load the default schema at ${label}. Check the module and its imports, or pass database({ schema }).`,
    );
  }
  if (
    typeof module !== "object" ||
    module === null ||
    !Object.hasOwn(module, "schema")
  ) {
    throw databaseSetupFailed(
      `The default schema module at ${label} must export a named "schema" created with defineSchema().`,
    );
  }
  let schema: unknown;
  try {
    schema = (module as { schema: unknown }).schema;
    assertFinalizedSchema(schema);
  } catch {
    throw databaseSetupFailed(
      `The "schema" export from ${label} must be a finalized AppKit schema created with defineSchema().`,
    );
  }
  return schema;
}
