import type { PluginExecuteConfig, PluginExecutionSettings } from "shared";
import type {
  AppKitTable,
  DataPath,
  IncludeSpec,
  OrderSpec,
  WhereSpec,
} from "@/database";
import { createLogger } from "@/logging/logger";
import { readDefaults, writeDefaults } from "./defaults";
import type { CacheSettings, EntityHooks, HookContext } from "./types";

const logger = createLogger("database:entity");
type Row = Record<string, unknown>;
const MAX_LIMIT = 500;

/**
 * Public column names (private columns omitted). Used as the default read
 * projection so columns marked `.private()` never leak via `appkit.database.<e>`
 * or generated routes unless the caller explicitly opts in via `.select()`.
 */
function publicColumnNames(table: AppKitTable): string[] {
  return Object.entries(table.$columns)
    .filter(([, meta]) => meta.private !== true)
    .map(([name]) => name);
}

type DatabaseAction =
  | "list"
  | "find"
  | "count"
  | "create"
  | "update"
  | "upsert"
  | "delete";

/**
 * Bound `Plugin#execute` wrapper passed in by `entity-wiring.ts`.
 *
 * `Plugin#execute` is `protected` and returns an `ExecutionResult<T>`
 * discriminated union. The wiring layer constructs an executor that calls the
 * protected method (legal in the same module), unwraps the result, and
 * rethrows on failure. Entity terminators see a flat "promise of T" contract.
 */
export type ExecutorFn = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: PluginExecutionSettings,
) => Promise<T>;

/**
 * Predicate accepted by `where`. A bare value is shorthand for equality; an
 * array is shorthand for `IN`; an object selects one or more operators.
 */
type WhereOperator<T> = {
  eq?: T;
  neq?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  like?: string;
  ilike?: string;
  in?: T[];
  is?: T | null;
};

export type WhereInput<TRow extends Row> = {
  [K in keyof TRow]?: TRow[K] | WhereOperator<TRow[K]>;
};

export type OrderInput<TRow extends Row> = {
  [K in keyof TRow]?: "asc" | "desc";
};

type RelatedRow<
  TIncludes,
  K extends keyof TIncludes,
> = TIncludes[K] extends Array<{
  row: infer R;
}>
  ? Extract<R, Row>
  : TIncludes[K] extends { row: infer R }
    ? Extract<R, Row>
    : Row;

export type IncludeInput<TIncludes> = {
  [K in keyof TIncludes]?:
    | true
    | {
        select?: ReadonlyArray<keyof RelatedRow<TIncludes, K>>;
        limit?: number;
        order?: OrderInput<RelatedRow<TIncludes, K>>;
        where?: WhereInput<RelatedRow<TIncludes, K>>;
      };
};

/**
 * Project the runtime shape of `.include({ K: ... })`. One-to-many includes
 * declare `Array<{ row: R }>` and resolve to `R[]`; one-to-one includes
 * declare `{ row: R }` and resolve to `R | null`.
 */
export type ApplyIncludes<TIncludes, I> = {
  [K in keyof I & keyof TIncludes]: TIncludes[K] extends Array<{ row: infer R }>
    ? Extract<R, Row>[]
    : TIncludes[K] extends { row: infer R }
      ? Extract<R, Row> | null
      : never;
};

/**
 * Public server-side entity facade exposed as `appkit.database.<entity>`.
 *
 * Chain methods accumulate query state and return a new client (immutable);
 * terminators run the query through the bound executor (`Plugin#execute`
 * wrap) and return a promise. All filter/order operators map one-to-one to
 * `DataPath` operators — AppKit does not own SQL translation; the runtime
 * (Drizzle) does.
 */
export interface EntityClient<
  TRow extends Row = Row,
  TInsert = TRow,
  TUpdate = Partial<TRow>,
  TIncludes = Record<string, { row: Row }>,
> {
  where(
    predicate: WhereInput<TRow>,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  order(
    input: OrderInput<TRow>,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  limit(n: number): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
  offset(n: number): EntityClient<TRow, TInsert, TUpdate, TIncludes>;

  /**
   * Opt out of the default `MAX_LIMIT` cap for `toArray()`. Use only for
   * background jobs that genuinely want every row — typical request handlers
   * should page or `limit()` instead. Server-side `statement_timeout` still
   * bounds runaway queries.
   */
  unbounded(): EntityClient<TRow, TInsert, TUpdate, TIncludes>;

  select<K extends keyof TRow & string>(
    ...cols: K[]
  ): EntityClient<Pick<TRow, K> & Row, TInsert, TUpdate, TIncludes>;

  include<I extends IncludeInput<TIncludes>>(
    input: I,
  ): EntityClient<
    TRow & ApplyIncludes<TIncludes, I>,
    TInsert,
    TUpdate,
    TIncludes
  >;

  toArray(): Promise<TRow[]>;
  first(): Promise<TRow | null>;
  find(id: string | number): Promise<TRow | null>;
  count(): Promise<number>;
  create(data: TInsert): Promise<TRow>;
  update(id: string | number, patch: TUpdate): Promise<TRow>;
  upsert(data: TInsert, options: { onConflict: keyof TRow }): Promise<TRow>;
  delete(id: string | number): Promise<void>;

  /**
   * Per-request OBO clone. Resolves the user identity from
   * `req.header("x-forwarded-email")` and swaps the underlying DataPath for a
   * per-user one. In dev without the OBO header, falls through to the SP
   * client (this) so the dev loop stays unbroken.
   */
  asUser(
    req: import("express").Request,
  ): EntityClient<TRow, TInsert, TUpdate, TIncludes>;
}

interface EntityClientDeps {
  /** Table metadata and Zod validators produced by `defineSchema`. */
  table: AppKitTable;
  /** Logical entity key used for cache keys, hook context, and telemetry. */
  entity: string;
  /** Service-principal data path. Default for non-OBO calls. */
  dataPath: DataPath;
  /** Single-column primary key. Defaults to `"id"` when schema metadata absent. */
  pkColumn?: string;
  hooks?: EntityHooks;
  /** Late-bound so `asUser(req)` can attach req/user info to hooks. */
  hookContext: () => HookContext;
  /** Bound `Plugin#execute` wrapper. Every terminator must go through this. */
  execute: ExecutorFn;
  /**
   * Build (or reuse) a per-user DataPath for this request. Returns `null` only
   * for the local dev fallback when the request lacks forwarded OBO identity.
   */
  makeUserDataPath: (req: import("express").Request) => DataPath | null;
  cache?: CacheSettings;
}

/**
 * Internal chain state.
 *
 * Pagination is tracked separately because PostgREST-style `offset(n).limit(m)`
 * needs to emit at the right moment, and `range(start, end)` competes with
 * the `offset/limit` pair. Everything else accumulates straight into the spec
 * objects.
 */
interface EntityClientState {
  where?: WhereSpec;
  order?: OrderSpec;
  limit?: number;
  offset?: number;
  columns?: string[];
  include?: IncludeSpec;
  /** Opt-out flag set by `.unbounded()` — bypasses the default `MAX_LIMIT` cap. */
  unbounded?: boolean;
  cacheKey: (string | number | object)[];
}

export function makeEntityClient<
  TRow extends Row = Row,
  TInsert = TRow,
  TUpdate = Partial<TRow>,
  TIncludes = Record<string, { row: Row }>,
>(deps: EntityClientDeps): EntityClient<TRow, TInsert, TUpdate, TIncludes> {
  return new EntityClientImpl<TRow, TInsert, TUpdate, TIncludes>(deps, {
    cacheKey: [deps.entity],
  }) as unknown as EntityClient<TRow, TInsert, TUpdate, TIncludes>;
}

/**
 * Thin immutable wrapper around the `DataPath` runtime.
 *
 * Each chain method returns a new wrapper with the spec extended. Terminators
 * call `this.run(action, fn)` which wraps the call in `Plugin#execute` so
 * telemetry, retry, cache, and timeout flow consistently for every action.
 */
class EntityClientImpl<
  TRow extends Row = Row,
  TInsert = TRow,
  TUpdate = Partial<TRow>,
  TIncludes = Record<string, { row: Row }>,
> {
  constructor(
    private readonly deps: EntityClientDeps,
    private readonly state: EntityClientState,
  ) {}

  where(predicate: WhereInput<TRow>) {
    // Filter spec is shallow-merged into the existing where so successive
    // `.where()` calls accumulate AND-style — matches the Supabase / Drizzle
    // intuition (no clobbering on repeated calls for distinct columns).
    return this.chain(
      {
        where: { ...this.state.where, ...(predicate as WhereSpec) },
      },
      { where: predicate },
    );
  }

  order(input: OrderInput<TRow>) {
    return this.chain(
      { order: { ...this.state.order, ...(input as OrderSpec) } },
      { order: input },
    );
  }

  limit(n: number) {
    const requested = Math.max(0, Math.floor(n));
    if (this.state.unbounded) {
      return this.chain({ limit: requested }, { limit: requested });
    }
    const limit = Math.min(MAX_LIMIT, requested);
    if (requested > MAX_LIMIT) {
      logger.warn(
        "limit(%d) on %s clamped to MAX_LIMIT=%d. Use .unbounded() for full scans.",
        requested,
        this.deps.entity,
        MAX_LIMIT,
      );
    }
    return this.chain({ limit }, { limit });
  }

  offset(n: number) {
    const offset = Math.max(0, Math.floor(n));
    return this.chain({ offset }, { offset });
  }

  unbounded() {
    return this.chain({ unbounded: true }, { unbounded: true });
  }

  select<K extends keyof TRow & string>(...cols: K[]) {
    const allowed = new Set(publicColumnNames(this.deps.table));
    const requested = cols.map(String);
    const dropped = requested.filter((c) => !allowed.has(c));
    if (dropped.length > 0) {
      logger.debug(
        "Dropped private/unknown column(s) from select on %s: %s",
        this.deps.entity,
        dropped.join(","),
      );
    }
    const filtered = requested.filter((c) => allowed.has(c));
    return this.chain({ columns: filtered }, { select: filtered.join(",") });
  }

  include<I extends IncludeInput<TIncludes>>(input: I) {
    return this.chain(
      { include: { ...this.state.include, ...(input as IncludeSpec) } },
      { include: input },
    ) as never;
  }

  asUser(req: import("express").Request) {
    // Dev fallback: when no user identity is forwarded and we're running
    // locally, return self so routes don't 401 / fail the dev loop. In
    // production, makeUserDataPath throws instead of silently falling back.
    const userDataPath = this.deps.makeUserDataPath(req);
    if (!userDataPath) return this;

    const userDeps: EntityClientDeps = {
      ...this.deps,
      dataPath: userDataPath,
      hookContext: () => ({
        ...this.deps.hookContext(),
        req,
        userId: req.header("x-forwarded-email"),
      }),
    };

    // Cache key includes the user identity so SP and OBO results don't share
    // a slot. In dev fallback (no x-forwarded-email), substitute the request
    // id so two unrelated dev requests don't share a cache slot named
    // `"unknown"` and cross-contaminate.
    const reqId = (req as { id?: unknown }).id;
    const identityKey =
      req.header("x-forwarded-email") ??
      (typeof reqId === "string" ? `unknown:${reqId}` : "unknown");
    return new EntityClientImpl<TRow, TInsert, TUpdate, TIncludes>(userDeps, {
      ...this.state,
      cacheKey: [
        this.deps.entity,
        "asUser",
        identityKey,
        ...this.state.cacheKey.slice(1),
      ],
    });
  }

  /* ----------------------------------------------------------------- *
   * Read terminators                                                   *
   * ----------------------------------------------------------------- */

  toArray(): Promise<TRow[]> {
    return this.run("list", async (signal) => {
      const rows = await this.deps.dataPath.select(this.deps.table, {
        where: this.state.where,
        order: this.state.order,
        ...this.resolvePagination(),
        columns: this.state.columns ?? publicColumnNames(this.deps.table),
        include: this.state.include,
        signal,
      });
      return rows as TRow[];
    });
  }

  first(): Promise<TRow | null> {
    return this.run("find", async (signal) => {
      const rows = await this.deps.dataPath.select(this.deps.table, {
        where: this.state.where,
        order: this.state.order,
        limit: 1,
        offset: this.state.offset,
        columns: this.state.columns ?? publicColumnNames(this.deps.table),
        include: this.state.include,
        signal,
      });
      return ((rows[0] as TRow) ?? null) as TRow | null;
    });
  }

  find(id: string | number): Promise<TRow | null> {
    return this.run("find", async (signal) => {
      const row = await this.deps.dataPath.findOne(
        this.deps.table,
        this.pk(),
        id,
        {
          columns: this.state.columns ?? publicColumnNames(this.deps.table),
          include: this.state.include,
          signal,
        },
      );
      return (row as TRow) ?? null;
    });
  }

  count(): Promise<number> {
    return this.run("count", async (signal) => {
      return await this.deps.dataPath.count(this.deps.table, {
        where: this.state.where,
        signal,
      });
    });
  }

  /* ----------------------------------------------------------------- *
   * Write terminators                                                  *
   * ----------------------------------------------------------------- */

  create(data: TInsert): Promise<TRow> {
    return this.run("create", async (signal) => {
      const ctx = this.deps.hookContext();
      const before = await this.deps.hooks?.beforeCreate?.(
        data as Record<string, unknown>,
        ctx,
      );
      const payload = before ?? data;
      const validated = this.deps.table.$insertSchema.parse(payload);
      const row = await this.deps.dataPath.insert(
        this.deps.table,
        validated as Row,
        signal,
      );
      await this.deps.hooks?.afterCreate?.(row, ctx);
      return row as TRow;
    });
  }

  update(id: string | number, patch: TUpdate): Promise<TRow> {
    return this.run("update", async (signal) => {
      const ctx = this.deps.hookContext();
      const before = await this.deps.hooks?.beforeUpdate?.(
        id,
        patch as Record<string, unknown>,
        ctx,
      );
      const payload = before ?? patch;
      const validated = this.deps.table.$updateSchema.parse(payload);
      const row = await this.deps.dataPath.update(
        this.deps.table,
        this.pk(),
        id,
        validated as Row,
        signal,
      );
      if (!row) {
        throw new Error(`update: ${this.deps.table.name} id=${id} not found`);
      }
      await this.deps.hooks?.afterUpdate?.(row, ctx);
      return row as TRow;
    });
  }

  upsert(data: TInsert, options: { onConflict: keyof TRow }): Promise<TRow> {
    return this.run("upsert", async (signal) => {
      const ctx = this.deps.hookContext();
      const before = await this.deps.hooks?.beforeUpsert?.(
        data as Record<string, unknown>,
        ctx,
      );
      const payload = before ?? data;
      const validated = this.deps.table.$insertSchema.parse(payload);
      const row = await this.deps.dataPath.upsert(
        this.deps.table,
        validated as Row,
        { onConflict: String(options.onConflict) },
        signal,
      );
      await this.deps.hooks?.afterUpsert?.(row, ctx);
      return row as TRow;
    });
  }

  delete(id: string | number): Promise<void> {
    return this.run("delete", async (signal) => {
      const ctx = this.deps.hookContext();
      await this.deps.hooks?.beforeDelete?.(id, ctx);
      await this.deps.dataPath.delete(this.deps.table, this.pk(), id, signal);
      await this.deps.hooks?.afterDelete?.(id, ctx);
    });
  }

  /* ----------------------------------------------------------------- *
   * Internals                                                          *
   * ----------------------------------------------------------------- */

  private chain(
    patch: Partial<Omit<EntityClientState, "cacheKey">>,
    cachePart?: string | number | object,
  ) {
    return new EntityClientImpl<TRow, TInsert, TUpdate, TIncludes>(this.deps, {
      ...this.state,
      ...patch,
      cacheKey:
        cachePart === undefined
          ? this.state.cacheKey
          : [...this.state.cacheKey, cachePart],
    });
  }

  private pk(): string {
    return this.deps.pkColumn ?? "id";
  }

  /**
   * Resolve final pagination shape for read terminators. When no limit is set
   * the cap is `MAX_LIMIT` so server reads stay bounded; callers that really
   * want every row opt in via `.unbounded()`. Throws when offset is set
   * without a limit, matching the previous behavior.
   */
  private resolvePagination(): { limit?: number; offset?: number } {
    if (this.state.offset !== undefined && this.state.limit === undefined) {
      throw new Error("offset() requires limit()");
    }
    const limit =
      this.state.limit ?? (this.state.unbounded ? undefined : MAX_LIMIT);
    return {
      limit,
      offset: this.state.offset,
    };
  }

  private run<T>(
    action: DatabaseAction,
    fn: (signal?: AbortSignal) => Promise<T>,
  ) {
    const isRead = action === "list" || action === "find" || action === "count";
    const baseDefaults: PluginExecuteConfig = isRead
      ? readDefaults
      : writeDefaults;

    const ttl =
      action === "list"
        ? this.deps.cache?.list?.ttl
        : action === "find"
          ? this.deps.cache?.find?.ttl
          : action === "count"
            ? this.deps.cache?.count?.ttl
            : undefined;

    const cache =
      ttl && ttl > 0
        ? {
            ...baseDefaults.cache,
            enabled: true,
            ttl,
            cacheKey: [
              "database",
              this.deps.entity,
              action,
              ...this.state.cacheKey,
            ],
          }
        : baseDefaults.cache;

    return this.deps.execute(fn, {
      default: {
        ...baseDefaults,
        cache,
        telemetryInterceptor: {
          spanName: `database.${this.deps.entity}.${action}`,
          attributes: {
            "database.entity": this.deps.entity,
            "database.action": action,
            "database.channel": "drizzle-pool",
          },
        },
      },
    });
  }
}
