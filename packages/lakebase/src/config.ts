import { WorkspaceClient } from "@databricks/sdk-experimental";
import type pg from "pg";
import { ConfigurationError, ValidationError } from "./errors";
import type { LakebasePoolConfig } from "./types";

/** Default configuration values for the Lakebase connector */
const defaults = {
  port: 5432,
  sslMode: "require" as const,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

const VALID_SSL_MODES = ["require", "disable", "prefer"] as const;
type SslMode = (typeof VALID_SSL_MODES)[number];

export interface ParsedPoolConfig {
  endpoint?: string;
  host: string;
  database: string;
  port: number;
  sslMode: SslMode;
  ssl?: pg.PoolConfig["ssl"];
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/** Parse pool configuration from provided config and environment variables */
export function parsePoolConfig(
  userConfig?: Partial<LakebasePoolConfig>,
): ParsedPoolConfig {
  // Get endpoint (required only for OAuth auth)
  const endpoint = userConfig?.endpoint ?? process.env.LAKEBASE_ENDPOINT;

  // Only require endpoint if no password provided
  if (!endpoint && !userConfig?.password) {
    throw ConfigurationError.missingEnvVar(
      "LAKEBASE_ENDPOINT or config.endpoint (or provide config.password for native auth)",
    );
  }

  // Get host (required)
  const host = userConfig?.host ?? process.env.PGHOST;
  if (!host) {
    throw ConfigurationError.missingEnvVar("PGHOST or config.host");
  }

  // Get database (required)
  const database = userConfig?.database ?? process.env.PGDATABASE;
  if (!database) {
    throw ConfigurationError.missingEnvVar("PGDATABASE or config.database");
  }

  // Get port (optional, default from defaults)
  const portStr = process.env.PGPORT;
  const port =
    userConfig?.port ??
    (portStr ? Number.parseInt(portStr, 10) : defaults.port);

  if (Number.isNaN(port)) {
    throw ValidationError.invalidValue("port", portStr, "a number");
  }

  // Get SSL mode (optional, default from defaults)
  const rawSslMode = userConfig?.sslMode ?? process.env.PGSSLMODE ?? undefined;

  const sslMode = validateSslMode(rawSslMode) ?? defaults.sslMode;

  // Pool options (with defaults)
  const max = userConfig?.max ?? defaults.max;
  const idleTimeoutMillis =
    userConfig?.idleTimeoutMillis ?? defaults.idleTimeoutMillis;
  const connectionTimeoutMillis =
    userConfig?.connectionTimeoutMillis ?? defaults.connectionTimeoutMillis;

  return {
    endpoint,
    host,
    database,
    port,
    sslMode,
    ssl: userConfig?.ssl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  };
}

/** Validate and return the SSL mode, or undefined when not set */
function validateSslMode(value: string | undefined): SslMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!(VALID_SSL_MODES as readonly string[]).includes(value)) {
    throw ValidationError.invalidValue(
      "sslMode (PGSSLMODE)",
      value,
      `one of: ${VALID_SSL_MODES.join(", ")}`,
    );
  }

  return value as SslMode;
}

/** Get workspace client from config or SDK default auth chain */
export async function getWorkspaceClient(
  config: Partial<LakebasePoolConfig>,
): Promise<WorkspaceClient> {
  // Priority 1: Explicit workspaceClient in config
  if (config.workspaceClient) {
    return config.workspaceClient;
  }

  // Priority 2: Create with SDK default auth chain
  // Use empty config to let SDK use .databrickscfg, DATABRICKS_HOST, DATABRICKS_TOKEN, etc.
  // NOTE: config.host is the PostgreSQL host (PGHOST), not the Databricks workspace host
  return new WorkspaceClient({});
}

/** Get username synchronously from config or environment */
export function getUsernameSync(config: Partial<LakebasePoolConfig>): string {
  // Priority 1: Explicit user in config
  if (config.user) {
    return config.user;
  }

  // Priority 2: PGUSER environment variable
  const pgUser = process.env.PGUSER;
  if (pgUser) {
    return pgUser;
  }

  // Priority 3: DATABRICKS_CLIENT_ID (service principal ID)
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  if (clientId) {
    return clientId;
  }

  throw ConfigurationError.missingEnvVar(
    "PGUSER, DATABRICKS_CLIENT_ID, or config.user",
  );
}
