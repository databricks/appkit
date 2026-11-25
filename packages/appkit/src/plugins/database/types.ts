import type { DatabaseRegistry } from "../../database/contract";
import type { Schema } from "../../database/schema-builder";
import type { DatabaseRoutes } from "./operations";

type RegistryTableName = Extract<keyof DatabaseRegistry, string>;

/** @internal Infer conventional schema names from typegen, when available. */
export type DefaultDatabaseSchema = Schema<
  [RegistryTableName] extends [never] ? string : RegistryTableName
>;

/**
 * Connection pool overrides. Statement and idle-in-transaction timeouts are
 * fixed by the plugin and cannot be changed here.
 */
export interface DatabasePoolConfig {
  /**
   * Maximum connections held by the pool. The Lakebase compute's connection
   * limit is shared with other pools such as `lakebase()`, every replica, and
   * any other client, so keep the sum below it.
   *
   * @defaultValue 105, the whole budget of the smallest (0.5 CU) compute
   */
  readonly max?: number;
  /** Milliseconds an idle connection stays open. @defaultValue 30000 */
  readonly idleTimeoutMillis?: number;
  /** Milliseconds to wait for a free connection. @defaultValue 10000 */
  readonly connectionTimeoutMillis?: number;
}

/** Configuration for one schema-bound DatabasePlugin instance. */
export type IDatabaseConfig<TSchema extends Schema = DefaultDatabaseSchema> = {
  /**
   * Explicit schema override. Otherwise, setup loads the discovered registry's
   * schema or the named `schema` export from `config/database/schema.ts` under
   * the application's working directory. With an explicit `routes` registry,
   * this must be the same schema object the registry loads. Missing or invalid
   * declarations fail setup before pool creation.
   */
  readonly schema?: TSchema;
  /**
   * By default, discover `server/database/routes/` through the generated
   * `server/database/routes.gen.ts` registry. The standard server build includes
   * its compiled entry automatically. Without any route sources, serve nothing.
   * Pass `false` to disable discovery and HTTP operations, or a generated
   * registry to override the convention.
   *
   * Setup loads its schema and every module it lists, then serves each
   * authorized operation at `/api/database/operations/:name` with its
   * declared method. An operation without `authorize` is skipped with a
   * warning. A malformed or duplicate operation, or a module that fails to
   * load, fails setup.
   *
   * `appkit.database` stays available to server code in all three cases.
   */
  readonly routes?: DatabaseRoutes | false;
  /**
   * Overrides for the connection pool. A warning is logged when callers queue
   * because every connection is in use.
   */
  readonly pool?: DatabasePoolConfig;
};
