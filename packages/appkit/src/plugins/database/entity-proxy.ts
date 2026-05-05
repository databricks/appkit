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

// RFC 5321 §4.5.3.1.3 caps email at 320 octets.
const MAX_EMAIL_LEN = 320;

/** Trim, lowercase, length-cap. Returns `null` for missing/empty/oversize. */
export function normalizeOboEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LEN) return null;
  return trimmed;
}

const logger = createLogger("database:entity");
type Row = Record<string, unknown>;
const MAX_LIMIT = 500;

// Default read projection — `.private()` columns never leak via
// `appkit.database.<e>` or generated routes unless `.select()`-ed in.
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
 * Bound `Plugin#execute` wrapper from `entity-wiring.ts`. Wiring unwraps the
 * `ExecutionResult<T>` union and rethrows on failure so entity terminators
 * see a flat `Promise<T>` contract.
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
 * Public server-side entity facade — `appkit.database.<entity>`.
 *
 * Chain methods are immutable; terminators run via the bound executor.
 * Filter/order operators map 1:1 to `DataPath` — SQL translation is the
 * runtime's job, not AppKit's.
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
   * Opt out of `MAX_LIMIT` for `toArray()`. Background jobs only — request
   * handlers should page or `limit()`. `statement_timeout` still bounds runaway.
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
   * Per-request OBO clone — resolves identity from `x-forwarded-email` and
   * swaps in a per-user DataPath. Without the header in dev, returns the SP
   * client so the dev loop stays unbroken.
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
  /** Build per-user DataPath. Returns `null` only in dev when OBO headers are absent. */
  makeUserDataPath: (req: import("express").Request) => DataPath | null;
  cache?: CacheSettings;
}

/**
 * Internal chain state. Pagination is tracked separately so `offset/limit`
 * can be resolved against `MAX_LIMIT` at terminator time.
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
 * Thin immutable wrapper around `DataPath`. Terminators go through
 * `this.run(action, fn)` → `Plugin#execute`, so telemetry, retry, cache,
 * and timeout flow consistently per action.
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
    // Successive .where() calls shallow-merge into AND. Matches Supabase/Drizzle
    // intuition; no clobbering on distinct columns.
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
    // Dev fallback: no OBO header → return self so routes don't 401. In prod
    // `makeUserDataPath` throws instead of silently falling back.
    const userDataPath = this.deps.makeUserDataPath(req);
    if (!userDataPath) return this;

    const email = normalizeOboEmail(req.header("x-forwarded-email"));
    const userDeps: EntityClientDeps = {
      ...this.deps,
      dataPath: userDataPath,
      hookContext: () => ({
        ...this.deps.hookContext(),
        req,
        userId: email ?? undefined,
      }),
    };

    // Identity is in the cache key so SP and OBO don't share a slot. Dev
    // fallback uses req.id so unrelated requests don't collide on a shared
    // `"unknown"` slot.
    const reqId = (req as { id?: unknown }).id;
    const identityKey =
      email ?? (typeof reqId === "string" ? `unknown:${reqId}` : "unknown");
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
        // id may be user-supplied — strip control chars + length-cap before logging.
        const safeId = String(id)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate
          .replace(/[\x00-\x1f\x7f]/g, "?")
          .slice(0, 64);
        throw new Error(
          `update: ${this.deps.table.name} not found (id=${safeId})`,
        );
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
   * Default cap is `MAX_LIMIT` so reads stay bounded; opt out via `.unbounded()`.
   * Throws when offset is set without limit.
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
