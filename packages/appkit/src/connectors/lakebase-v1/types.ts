import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";

/**
 * Configuration for LakebaseV1Connector
 *
 * @deprecated This connector is for Lakebase Provisioned only.
 * For new projects, use Lakebase Autoscaling instead: https://docs.databricks.com/aws/en/oltp/projects/
 *
 * This connector is compatible with Lakebase Provisioned: https://docs.databricks.com/aws/en/oltp/instances/
 *
 * Lakebase Autoscaling offers:
 * - Automatic compute scaling
 * - Scale-to-zero for cost optimization
 * - Database branching for development
 * - Instant restore capabilities
 *
 * Use the new LakebaseConnector (coming in a future release) for Lakebase Autoscaling support.
 */
export interface LakebaseV1Config {
  /** Databricks workspace client */
  workspaceClient?: WorkspaceClient;

  /** Connection string */
  connectionString?: string;

  /** Database host (e.g., instance-uuid.database.region.databricks.com) */
  host?: string;

  /** Database name */
  database?: string;

  /** Database port */
  port: number;

  /** App name */
  appName?: string;

  /** SSL mode */
  sslMode: "require" | "disable" | "prefer";

  /** Maximum number of connections in the pool */
  maxPoolSize: number;

  /** Close idle connections after this time (milliseconds) */
  idleTimeoutMs: number;

  /** Connection timeout (milliseconds) */
  connectionTimeoutMs: number;

  /** Telemetry configuration */
  telemetry?: TelemetryOptions;

  /** Additional configuration options */
  [key: string]: unknown;
}

/**
 * Lakebase V1 credentials for authentication
 *
 * @deprecated This type is for Lakebase Provisioned only.
 * For new projects, use Lakebase Autoscaling: https://docs.databricks.com/aws/en/oltp/projects/
 */
export interface LakebaseV1Credentials {
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Expires at */
  expiresAt: number;
}

/**
 * Internal connection configuration for Lakebase V1
 *
 * @deprecated This type is for Lakebase Provisioned only.
 * For new projects, use Lakebase Autoscaling: https://docs.databricks.com/aws/en/oltp/projects/
 */
export interface LakebaseV1ConnectionConfig {
  /** Database host */
  readonly host: string;
  /** Database name */
  readonly database: string;
  /** Database port */
  readonly port: number;
  /** SSL mode */
  readonly sslMode: "require" | "disable" | "prefer";
  /** App name */
  readonly appName?: string;
}
