import { WorkspaceClient } from "@databricks/sdk-experimental";
import { ConfigurationError, ValidationError } from "./errors";
import type { LakebaseAuthConfig, SslConfig } from "./types";

/** Default connection values for Lakebase auth */
const defaults = {
  port: 5432,
  sslMode: "require" as const,
};

const VALID_SSL_MODES = ["require", "disable", "prefer"] as const;
type SslMode = (typeof VALID_SSL_MODES)[number];

/** Connection essentials parsed from config and environment variables. */
export interface ParsedAuthConfig {
  endpoint?: string;
  host: string;
  database: string;
  port: number;
  sslMode: SslMode;
  ssl?: SslConfig;
}

/**
 * Map an SSL mode string to the corresponding SSL configuration.
 *
 * - `"require"` -- SSL enabled with certificate verification
 * - `"prefer"`  -- SSL enabled without certificate verification (try SSL, accept any cert)
 * - `"disable"` -- SSL disabled
 */
export function mapSslConfig(sslMode: SslMode): SslConfig {
  switch (sslMode) {
    case "require":
      return { rejectUnauthorized: true };
    case "prefer":
      return { rejectUnauthorized: false };
    case "disable":
      return false;
  }
}

/** Parse connection configuration from provided config and environment variables */
export function parseConfig(
  userConfig?: Partial<LakebaseAuthConfig>,
): ParsedAuthConfig {
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

  return {
    endpoint,
    host,
    database,
    port,
    sslMode,
    ssl: userConfig?.ssl,
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
export function getWorkspaceClient(
  config: Partial<LakebaseAuthConfig>,
): WorkspaceClient {
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
export function getUsernameSync(config: Partial<LakebaseAuthConfig>): string {
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
    "config.user, PGUSER or DATABRICKS_CLIENT_ID",
  );
}

/**
 * Resolves the PostgreSQL username for a Lakebase connection.
 *
 * Extends {@link getUsernameSync} with an async fallback that fetches the
 * current user's identity from the Databricks workspace API. Use this when
 * you don't have an explicit username configured and want automatic resolution
 * (e.g. human users authenticating via PAT or browser OAuth in ~/.databrickscfg).
 *
 * Resolution priority:
 * 1. `config.user` — explicit config value
 * 2. `PGUSER` env var
 * 3. `DATABRICKS_CLIENT_ID` env var (service principals)
 * 4. `currentUser.me()` — fetched from Databricks workspace API
 *
 * Returns `undefined` if all attempts fail rather than throwing, so the
 * caller can decide whether to proceed or surface an error.
 */
export async function getUsernameWithApiLookup(
  config?: Partial<LakebaseAuthConfig>,
): Promise<string | undefined> {
  try {
    return getUsernameSync(config ?? {});
  } catch {
    // sync resolution failed, try workspace API
  }

  try {
    const workspaceClient = getWorkspaceClient(config ?? {});
    const me = await workspaceClient.currentUser.me();
    return me.userName ?? undefined;
  } catch {
    return undefined;
  }
}
