import { ConfigurationError, ValidationError } from "../../errors";
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
      throw ValidationError.invalidValue(
        "protocol",
        url.protocol,
        "postgresql: or postgres:",
      );
    }

    if (!url.hostname) {
      throw ValidationError.missingField("hostname");
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
    throw ValidationError.missingField("database");
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
    throw ConfigurationError.missingEnvVar("PGHOST");
  }

  if (!database) {
    throw ConfigurationError.missingEnvVar("PGDATABASE");
  }

  return {
    host,
    database,
    port,
    sslMode: "require",
  };
}
