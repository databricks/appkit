import type { Pool } from "pg";
import { Plugin, toPlugin } from "@/plugin";
import { createLakebasePool } from "../../connectors/lakebase";
import { ConfigurationError } from "../../errors";
import { createLogger } from "../../logging/logger";
import type { PluginManifest } from "../../registry";
import { POOL_DEFAULTS } from "./defaults";
import manifest from "./manifest.json";
import type { IDatabaseConfig } from "./types";

const logger = createLogger("database");

class DatabasePlugin extends Plugin<IDatabaseConfig> {
  static manifest = manifest as PluginManifest<"database">;

  protected declare config: IDatabaseConfig;
  protected pool: Pool | null = null;

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
