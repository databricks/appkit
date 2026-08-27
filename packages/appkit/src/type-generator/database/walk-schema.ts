import type {
  AppKitTable,
  ColumnMeta,
  Schema,
} from "../../database/schema-builder";
import { filterOperatorsForKind } from "../../database/schema-builder/types";

/** Render-ready type facets for one database registry entry. */
interface RegistryEntry {
  readonly name: string;
  readonly row: string;
  readonly publicRow: string;
  readonly insert: string;
  readonly update: string;
  readonly filters: string;
  readonly includes: string;
  readonly hasPrimaryKey: boolean;
}

/** Keep generated scalars aligned with the schema's canonical runtime values. */
function tsType(meta: ColumnMeta): string {
  switch (meta.kind) {
    case "string":
    case "uuid":
    case "date":
      return "string";
    case "number":
      return "number";
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "json":
      return "unknown";
    case "enum":
      return (
        meta.enumValues?.map((value) => JSON.stringify(value)).join(" | ") ||
        "string"
      );
    default:
      return "unknown";
  }
}

function objectFacet(lines: string[], empty = "{}"): string {
  return lines.length ? `{\n${lines.join("\n")}\n    }` : empty;
}

function property(meta: ColumnMeta, optional = false): string {
  const nullable = meta.notNull ? "" : " | null";
  return `      ${JSON.stringify(meta.columnName)}${optional ? "?" : ""}: ${tsType(meta)}${nullable};`;
}

// Trusted facets retain private columns; only public rows project them out.
function rowType(table: AppKitTable, publicOnly: boolean): string {
  return objectFacet(
    Object.values(table.$columns)
      .filter((c) => !publicOnly || !c.isPrivate)
      .map((c) => property(c)),
    "Record<string, never>",
  );
}

// Write facets mirror trusted validators; updates additionally omit primary keys.
function insertType(table: AppKitTable): string {
  return objectFacet(
    Object.values(table.$columns)
      .filter((c) => !c.serverGenerated)
      .map((c) => property(c, !c.notNull || c.hasDefault)),
    "Record<string, never>",
  );
}

function updateType(table: AppKitTable): string {
  return objectFacet(
    Object.values(table.$columns)
      .filter((c) => !c.serverGenerated && !c.primaryKey)
      .map((c) => property(c, true)),
    "Record<string, never>",
  );
}

/** Reuse the canonical operator matrix when rendering `where()` types. */
function filtersType(table: AppKitTable): string {
  const direct = objectFacet(
    Object.values(table.$columns).flatMap((column) => {
      const operators = filterOperatorsForKind(column.kind);
      if (operators.length === 0) return [];
      const value = tsType(column);
      const fields = operators.map(
        (operator) =>
          `${operator}?: ${operator === "in" ? `readonly (${value})[]` : value};`,
      );
      if (!column.notNull) fields.push("is?: null;");
      return [
        `      ${JSON.stringify(column.columnName)}?: ${value} | readonly (${value})[] | { ${fields.join(" ")} };`,
      ];
    }),
  );
  return `DatabaseLogicalFilter<${direct}>`;
}

/** Preserve finalized relation identity and cardinality in include types. */
function includesType(table: AppKitTable): string {
  return objectFacet(
    table.$relations.map(
      (relation) =>
        `      ${JSON.stringify(relation.name)}: { to: ${JSON.stringify(relation.targetTable)}; many: ${relation.cardinality === "toMany"} };`,
    ),
  );
}

/** Preserve schema table identity as the generated registry key. */
export function walkSchema(schema: Schema): RegistryEntry[] {
  return Object.entries(schema.$tables).map(([name, table]) => ({
    name,
    row: rowType(table, false),
    publicRow: rowType(table, true),
    insert: insertType(table),
    update: updateType(table),
    filters: filtersType(table),
    includes: includesType(table),
    hasPrimaryKey: Object.values(table.$columns).some(
      (column) => column.primaryKey,
    ),
  }));
}
