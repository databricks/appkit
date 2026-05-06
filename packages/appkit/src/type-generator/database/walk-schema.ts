import { type ColumnInfo, pgTypeToColumnInfoKind } from "shared";
import { adaptDrizzleTable } from "../../database/introspector/drizzle-adapter";
import type { IntrospectedColumn } from "../../database/introspector/types";
import type { Schema } from "../../database/schema-builder/types";

/** Registry entry: string fields are ready-to-splice TS type literals. */
export interface RegistryEntry {
  entity: string;
  row: string;
  insert: string;
  update: string;
  filters: string;
  /** `"{}"` when no relations. */
  includes: string;
  /** Emitted to `database.columns.ts`. */
  columns: ColumnInfo[];
}

interface ForwardEdge {
  fromColumn: string;
  target: string;
}

interface ReverseEdge {
  fromEntity: string;
  fromColumn: string;
}

/** Walk `Schema` → flat registry entries (pure, no I/O). */
export function walkSchema(schema: unknown): RegistryEntry[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Schema;
  const tables = s.$tables;
  if (!tables || typeof tables !== "object") return [];

  // `Relation.toTable` is a SQL name; map it back to the JS entity key.
  const sqlNameToEntity = new Map<string, string>();
  for (const [entity, table] of Object.entries(tables)) {
    sqlNameToEntity.set(table.name, entity);
  }

  const forwardByEntity = new Map<string, ForwardEdge[]>();
  const reverseByEntity = new Map<string, ReverseEdge[]>();

  for (const [entity, table] of Object.entries(tables)) {
    const forward: ForwardEdge[] = [];
    for (const rel of table.$relations ?? []) {
      const target = sqlNameToEntity.get(rel.toTable);
      if (!target) continue;
      forward.push({ fromColumn: rel.fromColumn, target });
      const rev = reverseByEntity.get(target) ?? [];
      rev.push({ fromEntity: entity, fromColumn: rel.fromColumn });
      reverseByEntity.set(target, rev);
    }
    forwardByEntity.set(entity, forward);
  }

  const entries: RegistryEntry[] = [];
  for (const [entity, table] of Object.entries(tables)) {
    // Filter `private()` columns before emit — they must not reach the bundle.
    const columns = adaptDrizzleTable(table).columns.filter(
      (c) => table.$columns[c.name]?.private !== true,
    );
    entries.push({
      entity,
      row: renderRow(columns),
      insert: renderInsert(columns),
      update: renderUpdate(columns),
      filters: renderFilters(columns),
      includes: renderIncludes(
        forwardByEntity.get(entity) ?? [],
        reverseByEntity.get(entity) ?? [],
      ),
      columns: columns.map((col) => ({
        name: col.name,
        type: pgTypeToColumnInfoKind(col.pgType),
        nullable: col.nullable,
        primaryKey: col.isPrimaryKey === true,
        hasDefault: col.hasDefault,
        generated: col.serverGenerated === true,
      })),
    });
  }

  return entries;
}

function renderRow(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`,
  );
  return `{ ${fields.join(" ")} }`;
}

/** Insert: optional when nullable, defaulted, or server-generated. */
function renderInsert(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map((c) => {
    const optional = c.nullable || c.hasDefault || c.serverGenerated === true;
    const q = optional ? "?" : "";
    return `${safeProp(c.name)}${q}: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`;
  });
  return `{ ${fields.join(" ")} }`;
}

/** Update: every column optional. */
function renderUpdate(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}?: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`,
  );
  return `{ ${fields.join(" ")} }`;
}

function renderFilters(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}: ${JSON.stringify(pgTypeToFilterKind(c.pgType))};`,
  );
  return `{ ${fields.join(" ")} }`;
}

/** Forward edges → `{ row }`, reverse → `Array<{ row }>`; dup FKs key by column (PostgREST). */
function renderIncludes(
  forward: ForwardEdge[],
  reverse: ReverseEdge[],
): string {
  const parts: string[] = [];

  const forwardByTarget = groupBy(forward, (f) => f.target);
  for (const [target, edges] of forwardByTarget) {
    if (edges.length === 1) {
      parts.push(
        `${safeProp(target)}: { row: DatabaseRegistry[${JSON.stringify(target)}]["row"] };`,
      );
    } else {
      for (const edge of edges) {
        parts.push(
          `${safeProp(edge.fromColumn)}: { row: DatabaseRegistry[${JSON.stringify(target)}]["row"] };`,
        );
      }
    }
  }

  const reverseBySource = groupBy(reverse, (r) => r.fromEntity);
  for (const [source, edges] of reverseBySource) {
    if (edges.length === 1) {
      parts.push(
        `${safeProp(source)}: Array<{ row: DatabaseRegistry[${JSON.stringify(source)}]["row"] }>;`,
      );
    } else {
      for (const edge of edges) {
        parts.push(
          `${safeProp(edge.fromColumn)}: Array<{ row: DatabaseRegistry[${JSON.stringify(source)}]["row"] }>;`,
        );
      }
    }
  }

  if (parts.length === 0) return "{}";
  return `{ ${parts.join(" ")} }`;
}

/** pg → TS for `.d.ts` literals. Timestamps are `string` (JSON wire format). */
function pgTypeToTs(pgType: string): string {
  switch (pgType) {
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "number";
    case "bool":
      return "boolean";
    case "jsonb":
    case "json":
      return "unknown";
    case "text":
    case "varchar":
    case "char":
    case "bpchar":
    case "uuid":
    case "timestamp":
    case "timestamptz":
    case "date":
    case "time":
    case "timetz":
      return "string";
    default:
      return "unknown";
  }
}

/** Coarse filter kind so unknown pg types don't break codegen. */
function pgTypeToFilterKind(
  pgType: string,
): "string" | "number" | "boolean" | "date" {
  switch (pgType) {
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "number";
    case "bool":
      return "boolean";
    case "timestamp":
    case "timestamptz":
    case "date":
    case "time":
    case "timetz":
      return "date";
    default:
      return "string";
  }
}

function withNull(ts: string, nullable: boolean): string {
  return nullable ? `${ts} | null` : ts;
}

/** Quote keys that aren't valid bare JS identifiers. */
function safeProp(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function groupBy<T, K>(list: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = out.get(k) ?? [];
    bucket.push(item);
    out.set(k, bucket);
  }
  return out;
}
