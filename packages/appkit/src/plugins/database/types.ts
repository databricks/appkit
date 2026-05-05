import type { BasePluginConfig } from "shared";

/**
 * Pool tuning exposed via `IDatabaseConfig.connection`.
 * Intentionally excludes auth fields; Lakebase resolves credentials via OAuth + env.
 */
export interface DatabasePoolTuning {
  /** Maximum number of clients in the pool. */
  max?: number;
  /** Idle timeout (ms) before closing an idle client. */
  idleTimeoutMillis?: number;
  /** Connection acquire timeout (ms). */
  connectionTimeoutMillis?: number;
  /**
   * Recycle a client after N uses to reduce stale-token issues.
   */
  maxUses?: number;
  /**
   * Statement timeout (ms) set per new connection; top-level setting wins.
   */
  statement_timeout?: number;
  /** Random jitter (ms) added to statement timeout when supported. */
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
  /** Access mode for list. */
  list?: HttpAccess;
  /** Access mode for find. */
  find?: HttpAccess;
  /** Access mode for count. */
  count?: HttpAccess;
  /** Access mode for create. */
  create?: HttpAccess;
  /** Access mode for update. */
  update?: HttpAccess;
  /** Access mode for delete. */
  delete?: HttpAccess;
}

/**
 * Context for entity hooks.
 * @public
 */
export interface HookContext {
  /** Request object. */
  req?: import("express").Request;
  /** Entity name. */
  entity?: string;
  /** User ID. */
  userId?: string;
}

/**
 * Entity hooks.
 * @public
 */
export interface EntityHooks {
  /** Runs before create. */
  beforeCreate?: (
    data: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<Record<string, unknown> | void>;
  /** Runs after create. */
  afterCreate?: (
    row: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<void>;
  /** Runs before update. */
  beforeUpdate?: (
    id: unknown,
    patch: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<Record<string, unknown> | void>;
  /** Runs after update. */
  afterUpdate?: (
    row: Record<string, unknown>,
    ctx: HookContext,
  ) => Promise<void>;
  /** Runs before delete. */
  beforeDelete?: (id: unknown, ctx: HookContext) => Promise<void>;
  /** Runs after delete. */
  afterDelete?: (id: unknown, ctx: HookContext) => Promise<void>;
}

/**
 * Cache action settings.
 * @public
 */
export interface CacheActionSettings {
  /** Cache TTL in seconds. */
  ttl?: number;
}

/**
 * Cache settings.
 * @public
 */
export interface CacheSettings {
  /** Cache settings for list. */
  list?: CacheActionSettings;
  /** Cache settings for find. */
  find?: CacheActionSettings;
  /** Cache settings for count. */
  count?: CacheActionSettings;
}

/**
 * Database configuration.
 * @public
 */
export interface IDatabaseConfig extends BasePluginConfig {
  /**
   * Pool tuning forwarded to `createLakebasePool` (no auth fields).
   */
  connection?: DatabasePoolTuning;
  /** Per-entity HTTP access overrides. */
  http?: Record<string, HttpEntityOverride>;
  /** Per-entity lifecycle hooks. */
  hooks?: Record<string, EntityHooks>;
  /** Per-operation cache settings. */
  cache?: CacheSettings;
  /**
   * Max distinct OBO pools kept alive. Defaults to 25.
   * Worst-case fan-out is `(1 + oboPoolMax) × poolMax`.
   */
  oboPoolMax?: number;
  /**
   * Postgres `statement_timeout` (ms) for pooled connections. Defaults to 15s.
   * Set `0` to disable server-side timeout (client timeout still applies).
   */
  statementTimeoutMs?: number;
  /**
   * If true, `setup()` schema/drift failures are logged and ignored.
   * Defaults to false (fail closed).
   */
  tolerateSetupFailure?: boolean;
}
