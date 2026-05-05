import {
  and,
  asc,
  count as countFn,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { nonPrivateColumnNames } from "../schema-builder/private";
import type { AppKitTable, Schema } from "../schema-builder/types";
import type {
  DataPath,
  IncludeOptions,
  IncludeSpec,
  OrderSpec,
  Row,
  SelectOptions,
  WhereSpec,
} from "./data-path";

// Drizzle column type lives in `pg-core` internals — keep opaque so the rest
// of the file stays free of Drizzle generics.
type DrizzleColumn = unknown;

// Drizzle table — never narrowed; queries cast where Drizzle wants generics.
type DrizzleTable = Record<string, DrizzleColumn>;

/**
 * `manyToOne` — parent holds the FK (e.g. `user.team_id`).
 * `oneToMany` — related holds the FK back (e.g. `post.author_id`).
 */
type ResolvedRelation =
  | {
      kind: "manyToOne";
      relatedTable: AppKitTable;
      /** Column on the *parent* table holding the FK. */
      parentFk: string;
      /** Column on the *related* table being referenced (usually `id`). */
      relatedKey: string;
    }
  | {
      kind: "oneToMany";
      relatedTable: AppKitTable;
      /** Column on the *related* table holding the FK back to the parent. */
      relatedFk: string;
      /** Column on the *parent* table being referenced (usually `id`). */
      parentKey: string;
    };

/**
 * Build a `DataPath` backed by `drizzle-orm/node-postgres`.
 *
 * Sole `drizzle-orm` import site (decision #30) — swapping query builders
 * means rewriting only this file. `schema` resolves eager-loading relations
 * via a two-query pattern (parent + IN(ids)), avoiding N+1 without needing
 * Drizzle's `relations()` API.
 */
export function createDrizzleDataPath(pool: Pool, schema: Schema): DataPath {
  const db = drizzle(pool);
  return makeDataPath(db, schema);
}

/**
 * User-scoped `DataPath`: each op runs in a txn with `SET LOCAL app.user_id`.
 *
 * The txn is the security boundary — the GUC is txn-scoped, so a connection
 * returned to the pool can't leak identity to the next checkout. RLS policies
 * reading `current_setting('app.user_id')` resolve to the OBO user.
 *
 * One SP pool services everyone (no per-user pools, OAuth refresh, or LRU).
 * Cost: one BEGIN+COMMIT per op; amortize via `transaction(fn)` for multi-step.
 */
export function createUserScopedDataPath(
  pool: Pool,
  schema: Schema,
  context: { userId: string },
): DataPath {
  const db = drizzle(pool);

  // Each op opens its own txn + GUC. `transaction(fn)` shares one
  // BEGIN/SET LOCAL/COMMIT across nested ops.
  async function withUserContext<T>(
    fn: (tx: DataPath) => Promise<T>,
  ): Promise<T> {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction generic is opaque at this boundary.
    return await (db as any).transaction(async (tx: NodePgDatabase) => {
      // `set_config(_, _, true)` = parameterized SET LOCAL; cleared on COMMIT/ROLLBACK.
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${context.userId}, true)`,
      );
      return await fn(makeDataPath(tx, schema));
    });
  }

  const path: DataPath = {
    async select(table, opts) {
      return await withUserContext((tx) => tx.select(table, opts));
    },
    async findOne(table, pkColumn, id, opts) {
      return await withUserContext((tx) =>
        tx.findOne(table, pkColumn, id, opts),
      );
    },
    async count(table, opts) {
      return await withUserContext((tx) => tx.count(table, opts));
    },
    async insert(table, data, signal) {
      return await withUserContext((tx) => tx.insert(table, data, signal));
    },
    async update(table, pkColumn, id, patch, signal) {
      return await withUserContext((tx) =>
        tx.update(table, pkColumn, id, patch, signal),
      );
    },
    async upsert(table, data, options, signal) {
      return await withUserContext((tx) =>
        tx.upsert(table, data, options, signal),
      );
    },
    async delete(table, pkColumn, id, signal) {
      return await withUserContext((tx) =>
        tx.delete(table, pkColumn, id, signal),
      );
    },
    async transaction(fn) {
      return await withUserContext(fn);
    },
    async raw(strings, ...values) {
      return await withUserContext((tx) => tx.raw(strings, ...values));
    },
  };
  return path;
}

function makeDataPath(
  db: NodePgDatabase | NodePgDatabase<Record<string, never>>,
  schema: Schema,
): DataPath {
  const path: DataPath = {
    async select(table, opts) {
      const rows = await runSelect(db, table, opts);
      if (opts.include && rows.length > 0) {
        await applyIncludes(db, schema, table, rows, opts.include);
      }
      return rows;
    },

    async findOne(table, pkColumn, id, opts) {
      const pk = getColumn(table, pkColumn);
      const drizzleTable = table.$drizzle as DrizzleTable;
      const projection = projectColumns(table, opts?.columns);

      const builder = db
        .select(projection as never)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .from(drizzleTable as any)
        .where(eq(pk as never, id));

      const rows = (await maybeAbort(builder, opts?.signal)) as Row[];
      const row = rows[0] ?? null;

      if (row && opts?.include) {
        await applyIncludes(db, schema, table, [row], opts.include);
      }
      return row;
    },

    async count(table, opts) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
      const builder = db.select({ value: countFn() }).from(drizzleTable as any);
      const where = buildWhere(table, opts.where);
      const final = where ? builder.where(where) : builder;
      const result = (await maybeAbort(final, opts.signal)) as Array<{
        value: number;
      }>;
      return Number(result[0]?.value ?? 0);
    },

    async insert(table, data, signal) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      const returning = projectColumns(table, undefined);
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .insert(drizzleTable as any)
        .values(data as never)
        .returning(returning as never);
      const rows = (await maybeAbort(builder, signal)) as Row[];
      const row = rows[0];
      if (!row) {
        throw new Error(`insert into ${table.name} did not return a row`);
      }
      return row;
    },

    async update(table, pkColumn, id, patch, signal) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      const pk = getColumn(table, pkColumn);
      const returning = projectColumns(table, undefined);
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .update(drizzleTable as any)
        .set(patch as never)
        .where(eq(pk as never, id))
        .returning(returning as never);
      const rows = (await maybeAbort(builder, signal)) as Row[];
      return rows[0] ?? null;
    },

    async upsert(table, data, options, signal) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      const conflictCol = getColumn(table, options.onConflict);
      const returning = projectColumns(table, undefined);
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .insert(drizzleTable as any)
        .values(data as never)
        .onConflictDoUpdate({
          target: conflictCol as never,
          set: data as never,
        })
        .returning(returning as never);
      const rows = (await maybeAbort(builder, signal)) as Row[];
      const row = rows[0];
      if (!row) {
        throw new Error(`upsert on ${table.name} did not return a row`);
      }
      return row;
    },

    async delete(table, pkColumn, id, signal) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      const pk = getColumn(table, pkColumn);
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .delete(drizzleTable as any)
        .where(eq(pk as never, id));
      await maybeAbort(builder, signal);
    },

    async transaction(fn) {
      // Client-side cap on the whole callback. `statement_timeout` only bounds
      // individual queries — a workflow holding the txn open between queries
      // (e.g. awaiting an external API) wouldn't trip it. 30s catches stuck
      // callers without surprising healthy ones.
      const TRANSACTION_TIMEOUT_MS = 30_000;
      // biome-ignore lint/suspicious/noExplicitAny: tx shares the NodePgDatabase shape.
      const txnPromise = (db as any).transaction(async (tx: NodePgDatabase) => {
        return await fn(makeDataPath(tx, schema));
      }) as Promise<unknown>;

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `transaction(fn) exceeded ${TRANSACTION_TIMEOUT_MS}ms client-side cap`,
              ),
            ),
          TRANSACTION_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      try {
        return (await Promise.race([txnPromise, timeout])) as never;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async raw(strings, ...values) {
      // Hand off to Drizzle's `sql` tag — it parameterizes `values`, no string
      // concat happens here.
      const query = sql(
        Object.assign([...strings], {
          raw: [...strings],
        }) as TemplateStringsArray,
        ...values,
      );
      // biome-ignore lint/suspicious/noExplicitAny: execute() return shape varies by driver; rows is always present for node-postgres.
      const result = (await db.execute(query)) as { rows: unknown[] };
      return result.rows as never[];
    },
  };
  return path;
}

/* -------------------------------------------------------------------------- *
 * SELECT                                                                     *
 * -------------------------------------------------------------------------- */

async function runSelect(
  db: NodePgDatabase | NodePgDatabase<Record<string, never>>,
  table: AppKitTable,
  opts: SelectOptions,
): Promise<Row[]> {
  const drizzleTable = table.$drizzle as DrizzleTable;
  const projection = projectColumns(table, opts.columns);

  let builder = db
    .select(projection as never)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
    .from(drizzleTable as any) as any;

  const where = buildWhere(table, opts.where);
  if (where) builder = builder.where(where);

  const orderClauses = buildOrder(table, opts.order);
  if (orderClauses.length > 0) builder = builder.orderBy(...orderClauses);

  if (opts.limit !== undefined) builder = builder.limit(opts.limit);
  if (opts.offset !== undefined) builder = builder.offset(opts.offset);

  const rows = (await maybeAbort(builder, opts.signal)) as Row[];
  return rows;
}

// Always project explicitly — bare `select()` would `SELECT *` and leak
// `.private()` columns. Reused by `.returning()` on writes.
function projectColumns(
  table: AppKitTable,
  columns: ReadonlyArray<string> | undefined,
): Record<string, DrizzleColumn> {
  const names =
    columns && columns.length > 0 ? columns : nonPrivateColumnNames(table);
  const out: Record<string, DrizzleColumn> = {};
  for (const name of names) {
    out[name] = getColumn(table, name);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * WHERE                                                                      *
 * -------------------------------------------------------------------------- */

/**
 * @internal Exported for snapshot tests that lock in operator → SQL fragment
 * mapping. Not part of the public surface — go through `DataPath` instead.
 */
export function buildWhere(
  table: AppKitTable,
  spec: WhereSpec | undefined,
): SQL | undefined {
  if (!spec) return undefined;

  const conditions: SQL[] = [];
  for (const [columnName, value] of Object.entries(spec)) {
    const col = getColumn(table, columnName);

    if (Array.isArray(value)) {
      conditions.push(inArray(col as never, value as never[]));
      continue;
    }

    if (value === null) {
      // `= NULL` is never true in SQL — use IS NULL.
      conditions.push(isNull(col as never));
      continue;
    }

    if (typeof value !== "object") {
      conditions.push(eq(col as never, value as never));
      continue;
    }

    for (const op of Object.keys(value)) {
      if (!Object.hasOwn(value, op)) continue;
      const condition = buildOperator(
        col,
        op,
        (value as Record<string, unknown>)[op],
      );
      if (condition) conditions.push(condition);
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

function buildOperator(
  col: DrizzleColumn,
  op: string,
  value: unknown,
): SQL | undefined {
  switch (op) {
    case "eq":
      return eq(col as never, value as never);
    case "neq":
      return ne(col as never, value as never);
    case "gt":
      return gt(col as never, value as never);
    case "gte":
      return gte(col as never, value as never);
    case "lt":
      return lt(col as never, value as never);
    case "lte":
      return lte(col as never, value as never);
    case "like":
      return like(col as never, String(value));
    case "ilike":
      return ilike(col as never, String(value));
    case "in":
      return inArray(col as never, value as never[]);
    case "is":
      return value === null
        ? isNull(col as never)
        : eq(col as never, value as never);
    default:
      throw new Error(`Unsupported where operator: ${op}`);
  }
}

/* -------------------------------------------------------------------------- *
 * ORDER                                                                      *
 * -------------------------------------------------------------------------- */

/** @internal Exported for snapshot tests; same caveat as `buildWhere`. */
export function buildOrder(
  table: AppKitTable,
  spec: OrderSpec | undefined,
): SQL[] {
  if (!spec) return [];
  const out: SQL[] = [];
  for (const [columnName, direction] of Object.entries(spec)) {
    const col = getColumn(table, columnName);
    out.push(direction === "desc" ? desc(col as never) : asc(col as never));
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * INCLUDE (joins via two-query pattern)                                      *
 * -------------------------------------------------------------------------- */

async function applyIncludes(
  db: NodePgDatabase | NodePgDatabase<Record<string, never>>,
  schema: Schema,
  parentTable: AppKitTable,
  parentRows: Row[],
  spec: IncludeSpec,
): Promise<void> {
  // Two queries per relation (parent + related-rows-by-IN(ids)) avoids N+1
  // without Drizzle's relations API. Mutates parent rows in place.
  for (const [relationName, options] of Object.entries(spec)) {
    if (options === undefined) continue;
    const opts: IncludeOptions = options === true ? {} : options;
    const resolved = resolveRelation(schema, parentTable, relationName);

    if (resolved.kind === "manyToOne") {
      await applyManyToOne(db, parentRows, relationName, resolved, opts);
    } else {
      await applyOneToMany(db, parentRows, relationName, resolved, opts);
    }
  }
}

async function applyManyToOne(
  db: NodePgDatabase | NodePgDatabase<Record<string, never>>,
  parentRows: Row[],
  relationName: string,
  resolved: Extract<ResolvedRelation, { kind: "manyToOne" }>,
  opts: IncludeOptions,
): Promise<void> {
  const parentFkValues = uniqueDefined(
    parentRows.map((r) => r[resolved.parentFk]),
  );

  if (parentFkValues.length === 0) {
    for (const row of parentRows) row[relationName] = null;
    return;
  }

  const relatedTable = resolved.relatedTable;
  const relatedDrizzle = relatedTable.$drizzle as DrizzleTable;
  const relatedKey = getColumn(relatedTable, resolved.relatedKey);
  const projection = projectColumns(relatedTable, opts.select);

  // Drizzle `.where()` replaces on re-call — combine here, or the IN(parent_ids)
  // predicate gets dropped and the include leaks rows across parents.
  const inClause = inArray(relatedKey as never, parentFkValues as never[]);
  const userWhere = buildWhere(relatedTable, opts.where);
  const combined = userWhere ? and(inClause, userWhere) : inClause;

  let builder = db
    .select(projection as never)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque.
    .from(relatedDrizzle as any)
    .where(combined as never) as any;

  const order = buildOrder(relatedTable, opts.order);
  if (order.length > 0) builder = builder.orderBy(...order);

  const relatedRows = (await builder) as Row[];

  // Index by PK for O(1) parent assignment.
  const byKey = new Map<unknown, Row>();
  for (const row of relatedRows) {
    byKey.set(row[resolved.relatedKey], row);
  }

  for (const row of parentRows) {
    const fk = row[resolved.parentFk];
    row[relationName] = fk == null ? null : (byKey.get(fk) ?? null);
  }
}

async function applyOneToMany(
  db: NodePgDatabase | NodePgDatabase<Record<string, never>>,
  parentRows: Row[],
  relationName: string,
  resolved: Extract<ResolvedRelation, { kind: "oneToMany" }>,
  opts: IncludeOptions,
): Promise<void> {
  const parentKeyValues = uniqueDefined(
    parentRows.map((r) => r[resolved.parentKey]),
  );

  if (parentKeyValues.length === 0) {
    for (const row of parentRows) row[relationName] = [];
    return;
  }

  const relatedTable = resolved.relatedTable;
  const relatedDrizzle = relatedTable.$drizzle as DrizzleTable;
  const relatedFk = getColumn(relatedTable, resolved.relatedFk);
  const projection = projectColumns(relatedTable, opts.select);

  // Combine before `.where()` — see applyManyToOne.
  const inClause = inArray(relatedFk as never, parentKeyValues as never[]);
  const userWhere = buildWhere(relatedTable, opts.where);
  const combined = userWhere ? and(inClause, userWhere) : inClause;

  let builder = db
    .select(projection as never)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque.
    .from(relatedDrizzle as any)
    .where(combined as never) as any;

  const order = buildOrder(relatedTable, opts.order);
  if (order.length > 0) builder = builder.orderBy(...order);

  // `.limit(n)` would cap the whole query, not per-parent — apply per-parent
  // after fetch instead. Fine for small N; large fan-out should paginate
  // the parent query and call again.
  const relatedRows = (await builder) as Row[];

  const grouped = new Map<unknown, Row[]>();
  for (const row of relatedRows) {
    const key = row[resolved.relatedFk];
    const list = grouped.get(key);
    if (list) {
      list.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  for (const row of parentRows) {
    const key = row[resolved.parentKey];
    const list = grouped.get(key) ?? [];
    row[relationName] = opts.limit ? list.slice(0, opts.limit) : list;
  }
}

/**
 * Resolve a relation by name. Lookup is lenient: by related table name
 * (`{ posts: true }`), FK column (`{ author_id: true }`), or entity key.
 */
function resolveRelation(
  schema: Schema,
  parentTable: AppKitTable,
  relationName: string,
): ResolvedRelation {
  // Many-to-one: this table has a FK that matches the relation name.
  for (const rel of parentTable.$relations) {
    if (
      rel.fromColumn === relationName ||
      rel.toTable === relationName ||
      relationName === entityKeyOf(schema, rel.toTable)
    ) {
      const relatedTable = findTableByName(schema, rel.toTable);
      if (!relatedTable) {
        throw new Error(
          `Relation "${relationName}" on "${parentTable.name}" references unknown table "${rel.toTable}"`,
        );
      }
      return {
        kind: "manyToOne",
        relatedTable,
        parentFk: rel.fromColumn,
        relatedKey: rel.toColumn,
      };
    }
  }

  // One-to-many: another table has a FK back to this table.
  for (const [otherKey, otherTable] of Object.entries(schema.$tables)) {
    if (otherTable.name === parentTable.name) continue;
    for (const rel of otherTable.$relations) {
      if (rel.toTable !== parentTable.name) continue;
      if (relationName === otherKey || relationName === otherTable.name) {
        return {
          kind: "oneToMany",
          relatedTable: otherTable,
          relatedFk: rel.fromColumn,
          parentKey: rel.toColumn,
        };
      }
    }
  }

  throw new Error(
    `Unknown relation "${relationName}" on table "${parentTable.name}". ` +
      `Expected a foreign-key column on this table or another table referencing it.`,
  );
}

function findTableByName(
  schema: Schema,
  tableName: string,
): AppKitTable | undefined {
  for (const t of Object.values(schema.$tables)) {
    if (t.name === tableName) return t;
  }
  return undefined;
}

function entityKeyOf(schema: Schema, tableName: string): string | undefined {
  for (const [key, t] of Object.entries(schema.$tables)) {
    if (t.name === tableName) return key;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- *
 * Helpers                                                                    *
 * -------------------------------------------------------------------------- */

// Gate on `$columns` so untrusted input can't reach prototype keys or Drizzle internals.
function getColumn(table: AppKitTable, columnName: string): DrizzleColumn {
  if (typeof columnName !== "string" || columnName.length === 0) {
    throw new Error(
      `Invalid column reference on table "${table.name}": expected non-empty string`,
    );
  }
  if (!Object.hasOwn(table.$columns, columnName)) {
    throw new Error(`Unknown column "${columnName}" on table "${table.name}"`);
  }
  const drizzleTable = table.$drizzle as DrizzleTable;
  const col = drizzleTable[columnName];
  if (col === undefined || col === null) {
    throw new Error(
      `Column "${columnName}" missing from drizzle table "${table.name}" — schema/runtime out of sync`,
    );
  }
  return col;
}

// Placeholder for AbortSignal support — node-postgres won't cancel in-flight
// queries. `statement_timeout` (set on every pool connect) bounds runaway
// reads; AppKit's timeout interceptor still rejects the awaited promise.
async function maybeAbort<T>(
  builder: Promise<T> | { then: PromiseLike<T>["then"] },
  _signal?: AbortSignal,
): Promise<T> {
  return await (builder as Promise<T>);
}

function uniqueDefined<T>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const v of values) {
    if (v == null) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
