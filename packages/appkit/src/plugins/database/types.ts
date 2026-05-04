import type { BasePluginConfig } from "shared";

/** Pool tuning forwarded to `createLakebasePool` (no auth fields). */
export interface DatabasePoolTuning {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxUses?: number;
  statement_timeout?: number;
  statement_timeout_jitter_ms?: number;
}

/**
 * HTTP access control for entity operations.
 * @public
 */
export type HttpAccess = "public" | "obo" | "service" | false;

/**
 * HTTP access control overrides for entity operations.
 * @public
 */
export interface HttpEntityOverride {
  /** The HTTP access control for the list operation. */
  list?: HttpAccess;
  /** The HTTP access control for the find operation. */
  find?: HttpAccess;
  /** The HTTP access control for the count operation. */
  count?: HttpAccess;
  /** The HTTP access control for the create operation. */
  create?: HttpAccess;
  /** The HTTP access control for the update operation. */
  update?: HttpAccess;
  /** The HTTP access control for the delete operation. */
  delete?: HttpAccess;
  /**
   * Access control for the `_columns` metadata route used to auto-render
   * forms. Defaults to the same value as `list` — so an entity that is not
   * HTTP-listable also does not leak its column shape. Set explicitly to
   * `"public"` only when the schema is intentionally part of the public API.
   */
  columns?: HttpAccess;
}

/**
 * Context for entity hooks.
 * @public
 */
export interface HookContext {
  /** The request object. */
  req?: import("express").Request;
  /** The entity name. */
  entity?: string;
  /**
   * The forwarded user identity (`x-forwarded-email`).
   *
   * **Do not use for authorization decisions.** This is a transport-level
   * label populated from the same forwarded headers OBO uses; the actual
   * authentication signal is the access token on `req`. For authz, read the
   * verified user context off `req` — `userId` here is a convenience tag for
   * logging, audit fields, or distinguishing cache keys.
   */
  userId?: string;
}

// biome-ignore lint/suspicious/noConfusingVoidType: hooks may return nothing to keep the original payload.
type HookMutationResult = Record<string, unknown> | void;

/**
 * Entity hooks.
 * @public
 */
export interface EntityHooks {
  /** A hook to run before a create operation. */
  beforeCreate?: (
    data: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<HookMutationResult>;
  /** A hook to run after a create operation. */
  afterCreate?: (
    row: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<void>;
  /** A hook to run before an update operation. */
  beforeUpdate?: (
    id: unknown,
    patch: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<HookMutationResult>;
  /** A hook to run after an update operation. */
  afterUpdate?: (
    row: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<void>;
  /**
   * Run before an upsert operation.
   *
   * Note: `upsert` is a separate channel from `create` and `update` — it
   * does **not** invoke `beforeCreate`/`beforeUpdate` even when the resolved
   * branch is logically an insert or update. If you need shared mutation
   * logic, factor it into a helper and call it from both hooks (or from
   * `beforeCreate` + `beforeUpdate` + `beforeUpsert`).
   */
  beforeUpsert?: (
    data: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<HookMutationResult>;
  /**
   * Run after an upsert operation. See `beforeUpsert` — this is **not** a
   * fan-out of `afterCreate`/`afterUpdate`.
   */
  afterUpsert?: (
    row: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<void>;
  /** A hook to run before a delete operation. */
  beforeDelete?: (id: unknown, ctx: HookContext) => Promise<void>;
  /** A hook to run after a delete operation. */
  afterDelete?: (id: unknown, ctx: HookContext) => Promise<void>;
}

/**
 * Cache action settings.
 * @public
 */
export interface CacheActionSettings {
  /** The time to live for the cache in seconds. */
  ttl?: number;
}

/**
 * Cache settings.
 * @public
 */
export interface CacheSettings {
  /** The cache settings for the list operation. */
  list?: CacheActionSettings;
  /** The cache settings for the find operation. */
  find?: CacheActionSettings;
  /** The cache settings for the count operation. */
  count?: CacheActionSettings;
}

/**
 * Database configuration.
 * @public
 */
export interface IDatabaseConfig extends BasePluginConfig {
  /** The connection settings for the database. */
  connection?: DatabasePoolTuning;
  /** The HTTP entity overrides for the database. */
  http?: Record<string, HttpEntityOverride>;
  /** The entity hooks for the database. */
  hooks?: Record<string, EntityHooks>;
  /** Whether to check live schema drift during startup. */
  checkDrift?: boolean;
  /** Set `false` to suppress the `GET /api/database/_healthz` route. */
  healthCheck?: false;
  /** Set `false` to suppress the `GET /api/database/_entities` discovery route. */
  entitiesDiscovery?: false;
  /** The cache settings for the database. */
  cache?: CacheSettings;
  /**
   * Maximum number of distinct per-user (OBO) pools the registry keeps alive
   * at once. Each pool defaults to `OBO_POOL_DEFAULTS.max = 4` connections, so
   * the worst-case fan-out is `(1 + oboPoolMax) × poolMax`. Defaults to 25 —
   * tune up for hot OBO traffic, down for low-tier Lakebase plans.
   */
  oboPoolMax?: number;
  /**
   * Postgres `statement_timeout` applied to every pooled connection (ms).
   * Defaults to 15s. Set to `0` to disable the server-side cap; the AppKit
   * timeout interceptor still applies on the client side.
   */
  statementTimeoutMs?: number;
  /**
   * When true, schema-load and drift-check failures during `setup()` are
   * logged but do not throw. Defaults to false (fail closed). Useful in
   * environments where the database is provisioned out of band and the boot
   * shouldn't crash before the schema is reachable.
   */
  tolerateSetupFailure?: boolean;
}
