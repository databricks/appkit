import {
  createLakebasePool as createLakebasePoolBase,
  type LakebasePoolConfig,
} from "@databricks/lakebase";
import type pg from "pg";
import { createLogger } from "@/logging/logger";

/**
 * Create a Lakebase pool with appkit's logger integration.
 * Telemetry automatically uses appkit's OpenTelemetry configuration via global registry.
 *
 * @param config - Lakebase pool configuration
 * @returns PostgreSQL pool with appkit integration
 */
export function createLakebasePool(
  config?: Partial<LakebasePoolConfig>,
): pg.Pool {
  const logger = createLogger("connectors:lakebase");

  return createLakebasePoolBase({
    ...config,
    logger,
  });
}

// Re-export everything else from lakebase
export {
  createTokenRefreshCallback,
  type DatabaseCredential,
  type DriverTelemetry,
  type GenerateDatabaseCredentialRequest,
  generateDatabaseCredential,
  getLakebaseOrmConfig,
  getLakebasePgConfig,
  getWorkspaceClient,
  type LakebasePoolConfig,
  type Logger,
  type RequestedClaims,
  RequestedClaimsPermissionSet,
  type RequestedResource,
  type TokenRefreshDeps,
} from "@databricks/lakebase";
