import type {
  AppKitTable,
  ColumnMeta,
  Schema,
} from "../../database/schema-builder";
import { filterOperatorsForKind } from "../../database/schema-builder/types";
import {
  type ColumnHttpCapabilities,
  columnHttpCapabilities,
} from "../../plugins/database/crud/capabilities";

/** Render-ready HTTP facets, derived from the predicates the routes compile. */
interface ApiEntry {
  readonly insert: string;
  readonly update: string;
  readonly filters: string;
  readonly orderable: string;
  readonly key: string;
}

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
  readonly api: ApiEntry;
}

/** Indentation of a facet's key: trusted facets under an entry, HTTP under `api`. */
const TRUSTED = "    ";
const API = "      ";

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

function objectFacet(lines: string[], indent: string, empty = "{}"): string {
  return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : empty;
}

function property(meta: ColumnMeta, indent: string, optional = false): string {
  const nullable = meta.notNull ? "" : " | null";
  return `${indent}  ${JSON.stringify(meta.columnName)}${optional ? "?" : ""}: ${tsType(meta)}${nullable};`;
}

function literalUnion(names: string[]): string {
  return names.map((name) => JSON.stringify(name)).join(" | ") || "never";
}

// Trusted facets retain private columns; only public rows project them out.
function rowType(table: AppKitTable, publicOnly: boolean): string {
  return objectFacet(
    Object.values(table.$columns)
      .filter((c) => !publicOnly || !c.isPrivate)
      .map((c) => property(c, TRUSTED)),
    TRUSTED,
    "Record<string, never>",
  );
}

// Write facets mirror trusted validators; updates additionally omit primary keys.
function insertType(columns: ColumnMeta[], indent: string): string {
  return objectFacet(
    columns.map((c) => property(c, indent, !c.notNull || c.hasDefault)),
    indent,
    "Record<string, never>",
  );
}

function updateType(columns: ColumnMeta[], indent: string): string {
  return objectFacet(
    columns.map((c) => property(c, indent, true)),
    indent,
    "Record<string, never>",
  );
}

/**
 * Reuse the canonical operator matrix when rendering `where()` types. A
 * trusted `where()` also takes a bare array as `in`; the HTTP decoder does not.
 */
function filtersType(
  columns: ColumnMeta[],
  indent: string,
  arrayShorthand: boolean,
): string {
  const direct = objectFacet(
    columns.flatMap((column) => {
      const operators = filterOperatorsForKind(column.kind);
      if (operators.length === 0) return [];
      const value = tsType(column);
      const fields = operators.map(
        (operator) =>
          `${operator}?: ${operator === "in" ? `readonly (${value})[]` : value};`,
      );
      if (!column.notNull) fields.push("is?: null;");
      const shorthand = arrayShorthand ? ` | readonly (${value})[]` : "";
      return [
        `${indent}  ${JSON.stringify(column.columnName)}?: ${value}${shorthand} | { ${fields.join(" ")} };`,
      ];
    }),
    indent,
  );
  return `DatabaseLogicalFilter<${direct}>`;
}

/** Preserve finalized relation identity and cardinality in include types. */
function includesType(table: AppKitTable): string {
  return objectFacet(
    table.$relations.map(
      (relation) =>
        `${TRUSTED}  ${JSON.stringify(relation.name)}: { to: ${JSON.stringify(relation.targetTable)}; many: ${relation.cardinality === "toMany"} };`,
    ),
    TRUSTED,
  );
}

/** What the generated routes accept, from the predicates `compileTable` uses. */
function apiEntry(table: AppKitTable): ApiEntry {
  const columns = Object.values(table.$columns).map((meta) => ({
    meta,
    can: columnHttpCapabilities(meta),
  }));
  const columnsThat = (capability: keyof ColumnHttpCapabilities) =>
    columns.filter(({ can }) => can[capability]).map(({ meta }) => meta);
  const names = (metas: ColumnMeta[]) => metas.map((meta) => meta.columnName);
  return {
    insert: insertType(columnsThat("creatable"), API),
    update: updateType(columnsThat("updatable"), API),
    filters: filtersType(columnsThat("queryable"), API, false),
    orderable: literalUnion(names(columnsThat("queryable"))),
    key: literalUnion(names(columnsThat("publicKey"))),
  };
}

/** Preserve schema table identity as the generated registry key. */
export function walkSchema(schema: Schema): RegistryEntry[] {
  return Object.entries(schema.$tables).map(([name, table]) => {
    const columns = Object.values(table.$columns);
    return {
      name,
      row: rowType(table, false),
      publicRow: rowType(table, true),
      insert: insertType(
        columns.filter((c) => !c.serverGenerated),
        TRUSTED,
      ),
      update: updateType(
        columns.filter((c) => !c.serverGenerated && !c.primaryKey),
        TRUSTED,
      ),
      filters: filtersType(columns, TRUSTED, true),
      includes: includesType(table),
      hasPrimaryKey: columns.some((column) => column.primaryKey),
      api: apiEntry(table),
    };
  });
}
