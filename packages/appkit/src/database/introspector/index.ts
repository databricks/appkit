import type { Pool } from "pg";
import { inferRelationsByConvention } from "./infer-relations";
import { runIntrospection } from "./queries";
import type { IntrospectionResult } from "./types";

export {
  type DriftEntry,
  type DriftReport,
  type DriftSeverity,
  diffIntrospections,
} from "./diff";
export { formatDriftResolution } from "./drift-help";
export { renderSchema } from "./render";
export { extractSchema, isSchema } from "./schema-loader";
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
  /**
   * Infer foreign keys from naming convention when the database lacks
   * declared FK constraints. Defaults to `true` so `.include()` works on
   * schemas where FKs were never created at the DB level. Inferred relations
   * are marked with `references.inferred = true` and the renderer emits an
   * "inferred from naming convention" comment for human review.
   */
  inferRelations?: boolean;
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

  if (options.inferRelations !== false) {
    inferRelationsByConvention(tables);
  }

  if (options.readonly) {
    for (const table of tables) table.readonly = true;
  }

  return { schemas, tables };
}
