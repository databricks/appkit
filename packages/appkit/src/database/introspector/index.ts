import type { Pool } from "pg";
import { runIntrospection } from "./queries";
import type { IntrospectionResult } from "./types";

export {
  type DriftEntry,
  type DriftReport,
  type DriftSeverity,
  diffIntrospections,
} from "./diff";
export { renderSchema } from "./render";
export { schemaToIntrospection } from "./schema-to-introspection";
export { mapPostgresType } from "./type-map";
export type {
  CascadeAction,
  IntrospectedColumn,
  IntrospectedPolicy,
  IntrospectedTable,
  IntrospectionResult,
} from "./types";

/** Options for introspecting a database. */
export interface IntrospectOptions {
  schemas?: string[];
  exclude?: string[];
  readonly?: boolean;
}

/** Introspect a database and return the result. */
export async function introspect(
  pool: Pool,
  options: IntrospectOptions = {},
): Promise<IntrospectionResult> {
  const schemas = options.schemas ?? ["app", "public"];
  const exclude = new Set([
    "__appkit_migrations",
    "__drizzle_migrations",
    ...(options.exclude ?? []),
  ]);
  const tables = await runIntrospection(pool, schemas, exclude);

  if (options.readonly) {
    for (const table of tables) table.readonly = true;
  }

  return { schemas, tables };
}
