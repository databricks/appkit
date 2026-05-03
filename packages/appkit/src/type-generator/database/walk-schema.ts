import { adaptDrizzleTable } from "../../database/introspector/drizzle-adapter";
import type { IntrospectedColumn } from "../../database/introspector/types";
import type { AppKitTable, Schema } from "../../database/schema-builder/types";

/**
 * One entry in the emitted `DatabaseRegistry`. Each string field is a
 * pre-rendered TypeScript type literal ready to splice into the `.d.ts`
 * output — the generator does no further formatting on these.
 */
export interface RegistryEntry {
  /** JS entity key (the property name in `$tables`, e.g. `"activityLog"`). */
  entity: string;
  /** Type literal for `row: ...`. */
  row: string;
  /** Type literal for `insert: ...`. */
  insert: string;
  /** Type literal for `update: ...`. */
  update: string;
  /** Type literal for `filters: ...`. */
  filters: string;
  /** Type literal for `includes: ...`. `"{}"` when no relations exist. */
  includes: string;
}

/** Edge recorded during the forward pass so the reverse pass can consume it. */
interface ForwardEdge {
  fromColumn: string;
  target: string;
}

/** Edge recorded as "other entity points at me" during the forward pass. */
interface ReverseEdge {
  fromEntity: string;
  fromColumn: string;
}

/**
 * Walk a `Schema` and produce the flat registry entries that the generator
 * splices into the emitted `.d.ts`. This is pure — no I/O.
 *
 * Include inference runs in two passes. During the first pass, for each FK on
 * a table we record a forward edge (`table → target`) and, symmetrically, a
 * reverse edge on the target (`target ← table`). After all tables have been
 * visited we render the includes literal per entity, disambiguating
 * multi-FK pairs with the column name — which is exactly how PostgREST
 * disambiguates the same ambiguity in its embed syntax (`posts!author_id(*)`).
 */
export function walkSchema(schema: unknown): RegistryEntry[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Schema;
  const tables = s.$tables;
  if (!tables || typeof tables !== "object") return [];

  // Map SQL table name → entity (JS) key. `Relation.toTable` is a SQL name and
  // must be translated back to the entity key the registry is indexed by.
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
    const columns = adaptDrizzleTable(table).columns;
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
    });
  }

  return entries;
}

/** Render `{ col: TS | null; ... }` for all columns. */
function renderRow(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`,
  );
  return `{ ${fields.join(" ")} }`;
}

/**
 * Render insert shape. Columns are optional when nullable, have a default, or
 * are server-generated (serial PKs, `defaultNow()`-style timestamps, etc.).
 */
function renderInsert(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map((c) => {
    const optional = c.nullable || c.hasDefault || c.serverGenerated === true;
    const q = optional ? "?" : "";
    return `${safeProp(c.name)}${q}: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`;
  });
  return `{ ${fields.join(" ")} }`;
}

/** Render update shape — every column is optional. */
function renderUpdate(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}?: ${withNull(pgTypeToTs(c.pgType), c.nullable)};`,
  );
  return `{ ${fields.join(" ")} }`;
}

/** Render the `filters` map used by the type generator to classify columns. */
function renderFilters(columns: IntrospectedColumn[]): string {
  if (columns.length === 0) return "{}";
  const fields = columns.map(
    (c) =>
      `${safeProp(c.name)}: ${JSON.stringify(pgTypeToFilterKind(c.pgType))};`,
  );
  return `{ ${fields.join(" ")} }`;
}

/**
 * Render `includes: { ... }` combining forward (many-to-one, single object) and
 * reverse (one-to-many, array) relations. Colliding pairs (multiple FKs from
 * the same source to the same target) are keyed by column name so callers can
 * pick the one they want — matching PostgREST's `posts!author_id(*)` syntax.
 */
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

/**
 * Collapse a Postgres column type to a TypeScript type literal. Timestamps
 * stay as `string` because the browser path always receives JSON text; the
 * server path can widen to `string | Date` locally if it ever needs to.
 */
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

/**
 * Classifier used by the `filters` literal — a coarse kind that keeps the
 * type generator's output stable when new pg types are added. The classifier
 * lives here because the registry's `filters` shape is a client-facing
 * contract, not a Postgres one.
 */
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

/** Quote object keys only when they wouldn't be a valid JS identifier bare. */
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
