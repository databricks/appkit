import type { Pool } from "pg";
import { Plugin, toPlugin } from "@/plugin";
import { createLakebasePool } from "../../connectors/lakebase";
import type { Schema } from "../../database";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { PluginManifest } from "../../registry";
import { loadSchemaByConvention } from "./convention";
import { POOL_DEFAULTS } from "./defaults";
import manifest from "./manifest.json";
import type { IDatabaseConfig } from "./types";

const logger = createLogger("database");

class DatabasePlugin extends Plugin<IDatabaseConfig> {
  static manifest = manifest as PluginManifest<"database">;

  protected declare config: IDatabaseConfig;
  protected pool: Pool | null = null;
  protected schema: Schema | null = null;
  protected schemaPath: string | null = null;

  constructor(config: IDatabaseConfig = {}) {
    super(config);
    this.config = config;
  }

  async setup() {
    this.pool = createLakebasePool({
      ...POOL_DEFAULTS,
      ...this.config.connection,
    });
    logger.info("Database plugin pool initialized");

    const loaded = await loadSchemaByConvention();
    if (!loaded) {
      logger.warn(
        "Database plugin did not find config/database/schema.ts, using empty schema",
      );
      return;
    }

    this.schema = loaded.schema;
    this.schemaPath = loaded.schemaPath;
    logger.info(
      "Database schema loaded from %s with %d entries",
      loaded.schemaPath,
      Object.keys(loaded.schema.$tables).length,
    );
  }

  abortActiveOperations(): void {
    super.abortActiveOperations();
    if (!this.pool) return;

    logger.info("Closing database pool");
    this.pool.end().catch((err) => {
      logger.error("Error closing database pool: %O", err);
    });
    this.pool = null;
  }

  exports() {
    return {
      getPool: () => this.requirePool(),
    };
  }

  protected requirePool(): Pool {
    if (!this.pool) {
      throw ConfigurationError.resourceNotFound(
        "Database",
        "Database pool not initialized",
      );
    }
    return this.pool;
  }
}

export const database = toPlugin(DatabasePlugin);
