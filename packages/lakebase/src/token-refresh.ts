import { createPasswordProvider } from "@databricks/lakebase-auth";
import { createTelemetryFetchCredential, loggerToOnLog } from "./pool-config";
import type { DriverTelemetry } from "./telemetry";
import type { LakebasePoolConfig, Logger } from "./types";

export interface TokenRefreshDeps {
  userConfig: Partial<LakebasePoolConfig>;
  endpoint: string;
  telemetry: DriverTelemetry;
  logger?: Logger;
}

/**
 * Build a password callback with token caching, deduplication, and telemetry.
 *
 * @deprecated Prefer `createPasswordProvider` / `getPgConfig` from
 * `@databricks/lakebase-auth`. Retained for backwards compatibility; uses lazy
 * (on-demand) refresh to match the previous behavior.
 *
 * The returned async function is called by `pg.Pool` each time a new connection
 * is established. It caches OAuth tokens and deduplicates concurrent refresh
 * requests so only one API call is made even under parallel connection creation.
 */
export function createTokenRefreshCallback(
  deps: TokenRefreshDeps,
): () => Promise<string> {
  const fetchCredential = createTelemetryFetchCredential(deps);
  const { password } = createPasswordProvider({
    fetchCredential,
    mode: "lazy",
    onLog: loggerToOnLog(deps.logger),
  });
  return password;
}
