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
import type { AppKitTable, Schema } from "../schema-builder/types";
import type {
  CountOptions,
  DataPath,
  FindOneOptions,
  IncludeOptions,
  IncludeSpec,
  OrderSpec,
  Row,
  SelectOptions,
  WhereSpec,
} from "./data-path";

/**
 * Internal Drizzle column reference. Drizzle exposes columns as properties on
 * the table object (e.g. `userTable.email`), but their concrete type lives in
 * `drizzle-orm/pg-core` internals. We treat the column as opaque at this
 * boundary so the rest of the file stays free of Drizzle column generics.
 */
type DrizzleColumn = unknown;

/**
 * Internal Drizzle table reference. The table object carries column refs and
 * runtime metadata. We never narrow this type; queries cast it where Drizzle
 * APIs require concrete generics.
 */
type DrizzleTable = Record<string, DrizzleColumn>;

/**
 * Resolved relation between two tables.
 *
 * `manyToOne` — the parent table holds the foreign key (e.g. `user.team_id`).
 * `oneToMany` — the related table holds the foreign key (e.g. `post.author_id`).
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
 * Build a `DataPath` backed by `drizzle-orm/node-postgres` over a pg.Pool.
 *
 * This is the **only** AppKit file that imports `drizzle-orm` for query
 * execution (decision #30). All other code consumes the AppKit-shaped
 * `DataPath` interface, so swapping Drizzle for another query builder later
 * means rewriting just this file.
 *
 * `schema` is needed to resolve eager-loading relations — Drizzle's runtime
 * relations API would also work, but it requires `relations()` declarations
 * in the schema-builder which we don't generate today. We do joins via a
 * two-query pattern (parent + IN-clause for related rows) which avoids the
 * N+1 trap without requiring extra schema metadata.
 */
export function createDrizzleDataPath(pool: Pool, schema: Schema): DataPath {
  const db = drizzle(pool);
  return makeDataPath(db, schema);
}

/**
 * Build a user-scoped `DataPath` that wraps every operation in a database
 * transaction with `SET LOCAL app.user_id` set to the user's identity.
 *
 * The transaction is the security boundary: the GUC is transaction-scoped
 * (Postgres clears it on COMMIT/ROLLBACK), so a connection returned to the
 * pool cannot leak identity to the next checkout. RLS policies that read
 * `current_setting('app.user_id')` (or AppKit's emitted `current_user_id()`
 * helper) resolve to the OBO user.
 *
 * One SP pool services every user — connection count is independent of user
 * count, with no per-user OAuth refresh loops or LRU eviction. Cost is one
 * BEGIN+COMMIT round-trip per top-level operation; consumers amortize via
 * `transaction(fn)` for multi-step work.
 */
export function createUserScopedDataPath(
  pool: Pool,
  schema: Schema,
  context: { userId: string },
): DataPath {
  const db = drizzle(pool);

  // Each method opens its own transaction and sets the GUC, delegating the
  // actual query to a fresh DataPath bound to the txn. `transaction(fn)`
  // shares one BEGIN/SET LOCAL/COMMIT across the user's nested operations.
  async function withUserContext<T>(
    fn: (tx: DataPath) => Promise<T>,
  ): Promise<T> {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction generic is opaque at this boundary.
    return await (db as any).transaction(async (tx: NodePgDatabase) => {
      // `set_config(name, value, true)` is the parameterized form of
      // `SET LOCAL` — Postgres clears the value on COMMIT/ROLLBACK.
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

      const builder = (
        projection ? db.select(projection as never) : db.select()
      )
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
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .insert(drizzleTable as any)
        .values(data as never)
        .returning();
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
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .update(drizzleTable as any)
        .set(patch as never)
        .where(eq(pk as never, id))
        .returning();
      const rows = (await maybeAbort(builder, signal)) as Row[];
      return rows[0] ?? null;
    },

    async upsert(table, data, options, signal) {
      const drizzleTable = table.$drizzle as DrizzleTable;
      const conflictCol = getColumn(table, options.onConflict);
      const builder = db
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque at this boundary.
        .insert(drizzleTable as any)
        .values(data as never)
        .onConflictDoUpdate({
          target: conflictCol as never,
          set: data as never,
        })
        .returning();
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
      // Client-side cap for the whole `transaction(fn)` callback. The server
      // also enforces `statement_timeout` per session, but a long-running
      // workflow that holds the txn open between queries (e.g. waiting on an
      // external API) wouldn't trip a per-statement cap. 30s is a default
      // ceiling that catches stuck callers without surprising healthy ones.
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
      // Drizzle's `sql` tag accepts the same shape as a TaggedTemplateLiteral.
      // We pass the strings array straight through and let Drizzle bind values
      // as parameters, avoiding any string concatenation here.
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

  let builder = (projection ? db.select(projection as never) : db.select())
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

/**
 * Project a subset of columns into a Drizzle `select({ ... })` shape, or
 * return `undefined` to mean "all columns" (Drizzle's default behavior when
 * `select()` is called with no arguments returns the full row).
 */
function projectColumns(
  table: AppKitTable,
  columns: ReadonlyArray<string> | undefined,
): Record<string, DrizzleColumn> | undefined {
  if (!columns || columns.length === 0) return undefined;
  const out: Record<string, DrizzleColumn> = {};
  for (const name of columns) {
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

    if (value === null || typeof value !== "object") {
      conditions.push(eq(col as never, value as never));
      continue;
    }

    for (const [op, opValue] of Object.entries(value)) {
      const condition = buildOperator(col, op, opValue);
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
  // Mutate parent rows in place — adding each relation as either an array
  // (one-to-many) or a single value/null (many-to-one). Two queries per
  // relation: one to fetch the parent, one to fetch the related rows with
  // `IN (parent_ids)`. This avoids N+1 without needing Drizzle's relations API.
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

  let builder = (projection ? db.select(projection as never) : db.select())
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque.
    .from(relatedDrizzle as any)
    .where(inArray(relatedKey as never, parentFkValues as never[])) as any;

  const where = buildWhere(relatedTable, opts.where);
  if (where) builder = builder.where(and(where) as never);

  const order = buildOrder(relatedTable, opts.order);
  if (order.length > 0) builder = builder.orderBy(...order);

  const relatedRows = (await builder) as Row[];

  // Index related by their PK for O(1) lookup when assigning to parents.
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

  let builder = (projection ? db.select(projection as never) : db.select())
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table generic is opaque.
    .from(relatedDrizzle as any)
    .where(inArray(relatedFk as never, parentKeyValues as never[])) as any;

  const where = buildWhere(relatedTable, opts.where);
  if (where) builder = builder.where(and(where) as never);

  const order = buildOrder(relatedTable, opts.order);
  if (order.length > 0) builder = builder.orderBy(...order);

  // We deliberately apply `limit` AFTER fetching, per parent — Drizzle's
  // `.limit(n)` would cap the *whole* query, not per-parent. For small N
  // this is acceptable; for large fan-out, consumers should paginate the
  // parent query and call again.
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
 * Resolve a relation by name on `parentTable`. The lookup is intentionally
 * lenient about naming: a relation can be referenced by the related table
 * name (`{ posts: true }` on a `user` row), by the FK column name
 * (`{ author_id: true }`), or by the entity key (the schema's exported name
 * for the related table).
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

/** Pull a Drizzle column reference off the table by name. */
function getColumn(table: AppKitTable, columnName: string): DrizzleColumn {
  const drizzleTable = table.$drizzle as DrizzleTable;
  const col = drizzleTable[columnName];
  if (!col) {
    throw new Error(
      `Column "${columnName}" not found on table "${table.name}". ` +
        `Available columns: ${Object.keys(drizzleTable)
          .filter(
            (k) => !k.startsWith("_") && typeof drizzleTable[k] === "object",
          )
          .join(", ")}`,
    );
  }
  return col;
}

/**
 * Hook the optional `AbortSignal` into the Drizzle builder if the underlying
 * driver supports cancellation. `node-postgres` does not honor AbortSignal at
 * the query level today; this is a placeholder for future driver support.
 *
 * Returns the awaited result of the builder either way.
 */
async function maybeAbort<T>(
  builder: Promise<T> | { then: PromiseLike<T>["then"] },
  _signal?: AbortSignal,
): Promise<T> {
  // Intentional no-op for the signal: node-postgres does not cancel in-flight
  // queries. Server-side `statement_timeout` (set on every pool connection by
  // the plugin) is what actually bounds runaway reads. The AppKit timeout
  // interceptor still rejects the awaited promise when fired.
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
