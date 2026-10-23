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
   * Explicit schema override. Without `routes`, setup otherwise loads the
   * named `schema` export from `config/database/schema.ts` under the
   * application's working directory. With `routes`, setup uses the schema the
   * registry loads, and a different `schema` here fails setup. Missing or
   * invalid declarations fail setup before pool creation.
   */
  readonly schema?: TSchema;
  /**
   * The generated registry of named operations: `database({ routes: databaseRoutes })`.
   * Setup loads its schema and every module it lists, then serves each
   * authorized operation at `/api/database/operations/:name` with its
   * declared method. An operation without `authorize` is skipped with a
   * warning. A malformed or duplicate operation, or a module that fails to
   * load, fails setup.
   *
   * Absent or `false` serves no database endpoint over HTTP; `appkit.database`
   * stays available to server code either way.
   */
  readonly routes?: DatabaseRoutes | false;
  /**
   * Overrides for the connection pool. A warning is logged when callers queue
   * because every connection is in use.
   */
  readonly pool?: DatabasePoolConfig;
};
