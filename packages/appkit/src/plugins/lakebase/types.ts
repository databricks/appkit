import type { BasePluginConfig } from "shared";
import type { LakebasePoolConfig } from "../../connectors/lakebase";

/**
 * Configuration for the Lakebase plugin.
 *
 * The minimum required setup is via environment variables — no `pool` config
 * is needed if `PGHOST`, `PGDATABASE`, and `LAKEBASE_ENDPOINT` are set.
 *
 * @see {@link https://github.com/databricks/appkit/blob/main/packages/lakebase/README.md} for the full configuration reference.
 */
export interface ILakebaseConfig extends BasePluginConfig {
  /**
   * Optional overrides for the underlying `pg.Pool` configuration.
   * All fields are optional and fall back to environment variables or defaults.
   *
   * Common overrides: `max` (pool size), `connectionTimeoutMillis`, `idleTimeoutMillis`.
   */
  pool?: Partial<LakebasePoolConfig>;
}
