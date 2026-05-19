import type { BasePluginConfig } from "shared";
import type { LakebasePoolConfig } from "../../connectors/lakebase";

/**
 * Opt-in configuration for exposing Lakebase as an agent-callable SQL tool.
 *
 * This tool executes LLM-authored SQL against the Lakebase pool. The pool is
 * **always bound to the application's service-principal credentials**, so any
 * agent that can call this tool effectively has full SP access to the database
 * regardless of which end user initiated the request — setting
 * `exposeAsAgentTool` is itself the deliberate opt-in. The plugin emits a
 * startup `warn` log whenever the tool is enabled.
 *
 * When `readOnly: true` (default when opted in), every statement is:
 * 1. Classified by {@link @databricks/appkit's sql-policy classifier}; anything
 *    that isn't a pure `SELECT`/`WITH`/`SHOW`/`EXPLAIN`/`DESCRIBE` is rejected.
 * 2. Executed inside a `BEGIN READ ONLY … ROLLBACK` transaction so the
 *    PostgreSQL server rejects writes that slip past the classifier (e.g., a
 *    `SELECT` over a function with side effects).
 *
 * When `readOnly: false`, the tool is annotated `effect: "destructive"` and
 * the agents plugin will require human approval for every invocation (see
 * `AgentsPluginConfig.approval`).
 */
export interface LakebaseExposeAsAgentTool {
  /**
   * Enforce read-only execution. Defaults to `true`. Set to `false` to allow
   * destructive statements — highly discouraged outside of tightly controlled
   * single-user deployments. Combined with the `effect: "destructive"`
   * annotation, the agents plugin will require explicit human approval for
   * each call.
   */
  readOnly?: boolean;
}

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
  /**
   * Opt-in to expose Lakebase as an agent-callable SQL tool. By default no
   * agent tool is registered — the Lakebase plugin only exposes its API to
   * application code. See {@link LakebaseExposeAsAgentTool} for the privilege
   * implications of enabling this.
   */
  exposeAsAgentTool?: LakebaseExposeAsAgentTool;
}
