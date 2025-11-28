import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { TelemetryOptions } from "shared";

/** Configuration for LakebaseConnector */
export interface LakebaseConfig {
  /** Databricks workspace client */
  workspaceClient?: WorkspaceClient;

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

  /** How long credentials are valid (milliseconds) */
  credentialTTLMs: number;

  /** Telemetry configuration */
  telemetry?: TelemetryOptions;

  /** Additional configuration options */
  [key: string]: unknown;
}

/** Lakebase credentials for authentication */
export interface LakebaseCredentials {
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Expires at */
  expiresAt: number;
}

/** Internal connection configuration */
export interface LakebaseConnectionConfig {
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
