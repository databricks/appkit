import {
  createLakebasePool as createLakebasePoolBase,
  getUsernameWithApiLookup,
  type LakebasePoolConfig,
} from "@databricks/lakebase";
import type { Pool } from "pg";

import { getClientOptions } from "../../context/client-options";
import { ServiceContext } from "../../context/service-context";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import { createWorkspaceClient } from "../../workspace-client";

/**
 * Create a Lakebase pool with appkit's logger integration.
 * Telemetry automatically uses appkit's OpenTelemetry configuration via global registry.
 *
 * @param config - Lakebase pool configuration
 * @returns PostgreSQL pool with appkit integration
 */
export function createLakebasePool(config?: Partial<LakebasePoolConfig>): Pool {
  return createLakebasePoolBase({
    logger: createLogger("connectors:lakebase"),
    ...config,
  });
}

/**
 * Resolve the startup identity and create a pool through the existing Lakebase
 * connector. Explicit clients win over the app's service client; request/OBO
 * context is never selected implicitly. The pool connects lazily on first use.
 *
 * Keep createLakebasePool synchronous for existing callers and OBO pool caches.
 */
export async function initializeLakebasePool(
  config: Partial<LakebasePoolConfig> = {},
): Promise<Pool> {
  const resolved = { ...config };
  // Native password auth with an explicit/environment user needs no Databricks
  // client. Otherwise use one client for both identity lookup and token refresh.
  const needsClient =
    config.password === undefined ||
    !(config.user || process.env.PGUSER || process.env.DATABRICKS_CLIENT_ID);
  if (!resolved.workspaceClient && needsClient) {
    const client = ServiceContext.isInitialized()
      ? ServiceContext.get().client
      : createWorkspaceClient({ clientOptions: getClientOptions() });
    resolved.workspaceClient = client.toLegacyWorkspaceClient();
  }
  const user = await getUsernameWithApiLookup(resolved);
  if (!user) {
    throw ConfigurationError.invalidConnection(
      "Lakebase",
      "Could not determine the PostgreSQL user from the current Databricks credentials. Check your authentication or set PGUSER explicitly.",
    );
  }
  return createLakebasePool({ ...resolved, user });
}

// Re-export everything else from lakebase
export {
  type DatabaseCredential,
  type GenerateDatabaseCredentialRequest,
  generateDatabaseCredential,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getUsernameWithApiLookup,
  getWorkspaceClient,
  type LakebasePoolConfig,
  type RequestedClaims,
  RequestedClaimsPermissionSet,
  type RequestedResource,
} from "@databricks/lakebase";

export {
  createLakebasePoolManager,
  type LakebasePoolManager,
} from "./pool-manager";

export { type LakebasePool, RoutingPool } from "./routing-pool";
