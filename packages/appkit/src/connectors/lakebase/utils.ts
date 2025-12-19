import type { LakebaseConnectionConfig } from "./types";

export interface ParsedConnectionString {
  connectionParams: LakebaseConnectionConfig;
  originalConnectionString: string;
}

/** Parse connection string or environment variables */
export function parseConnectionString(
  connectionStringOrHost: string,
  database?: string,
  port?: number,
): ParsedConnectionString {
  if (
    connectionStringOrHost.startsWith("postgresql://") ||
    connectionStringOrHost.startsWith("postgres://")
  ) {
    // parse full connection string
    const cleanedString = connectionStringOrHost.replace(
      /:?\$\{PGPASSWORD\}@/,
      "@",
    );
    const url = new URL(cleanedString);

    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new Error(
        `Invalid connection string protocol: ${url.protocol}. Expected postgresql: or postgres:`,
      );
    }

    if (!url.hostname) {
      throw new Error("Connection string must include a hostname");
    }

    const dbName = url.pathname.slice(1) || "databricks_postgres";
    const sslMode =
      (url.searchParams.get("sslmode") as "require" | "disable" | "prefer") ||
      "require";

    const connectionParams: LakebaseConnectionConfig = {
      host: url.hostname,
      database: dbName,
      port: url.port ? parseInt(url.port, 10) : 5432,
      sslMode,
    };

    return {
      connectionParams,
      originalConnectionString: connectionStringOrHost,
    };
  }

  if (!database) {
    throw new Error(
      "Database name is required when using hostname directly (PGHOST format)",
    );
  }

  const connectionParams: LakebaseConnectionConfig = {
    host: connectionStringOrHost,
    database,
    port: port || 5432,
    sslMode: "require",
  };

  return {
    connectionParams,
    originalConnectionString: `postgresql://<user>:<password>@${connectionStringOrHost}:${port || 5432}/${database}`,
  };
}

/** Parse connection configuration from environment variables */
export function parseFromEnv(): LakebaseConnectionConfig {
  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;

  if (!host) {
    throw new Error("PGHOST environment variable is required");
  }

  if (!database) {
    throw new Error("PGDATABASE environment variable is required");
  }

  return {
    host,
    database,
    port,
    sslMode: "require",
  };
}
