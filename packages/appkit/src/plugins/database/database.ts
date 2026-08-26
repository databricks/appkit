import type { BasePluginConfig, PluginConstructor } from "shared";

import { DatabasePluginError } from "../../database/errors";
import type { Schema } from "../../database/schema-builder";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import type { DatabaseExports } from "./entity-types";
import { createDatabaseState, type DatabaseState } from "./lifecycle";
import manifest from "./manifest.json";
import type { IDatabaseConfig } from "./types";

/** Schema-driven database plugin */
export class DatabasePlugin<TSchema extends Schema> extends Plugin<
  IDatabaseConfig<TSchema>
> {
  /** Plugin metadata and required PostgreSQL resource. */
  static manifest = manifest as PluginManifest<"database">;
  declare protected config: IDatabaseConfig<TSchema>;
  private state: DatabaseState | null = null;
  private setupPromise: Promise<void> | null = null;
  private draining = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: IDatabaseConfig<TSchema>) {
    super({ schema: config.schema });
    this.config = { schema: config.schema };
  }

  /** Build and verify one candidate state before publishing its exports. */
  async setup(): Promise<void> {
    if (this.draining || this.state)
      throw new DatabasePluginError("SETUP_FAILED", "setup");
    if (!this.setupPromise) {
      const attempt = (async () => {
        const candidate = await createDatabaseState(
          this.config.schema,
          (operation, options) => this.execute(operation, options),
        );
        if (this.draining) {
          // Setup may finish while shutdown is waiting; never publish that state.
          candidate.deactivate();
          await candidate.pool.end().catch(() => undefined);
          throw new DatabasePluginError("SETUP_FAILED", "setup");
        }
        this.state = candidate;
      })();
      this.setupPromise = attempt;
    }
    return this.setupPromise;
  }

  /** Return the typed database API only while the plugin is active. */
  exports() {
    if (!this.state || this.draining)
      throw new DatabasePluginError("INTERNAL", "read");
    // AppKit binds exported functions onto this object on every access.
    return Object.assign(
      Object.create(null),
      this.state.exports,
    ) as DatabaseExports;
  }

  /** Stop new work, wait for setup, and close the owned pool exactly once. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = (async () => {
      await this.setupPromise?.catch(() => undefined);
      const state = this.state;
      state?.deactivate();
      this.state = null;
      if (state) {
        try {
          await state.pool.end();
        } catch {
          throw new DatabasePluginError("INTERNAL", "shutdown");
        }
      }
    })();
    return this.shutdownPromise;
  }
}

/** Create a typed database plugin registration for a finalized schema. */
export function database<TSchema extends Schema>(
  config: IDatabaseConfig<TSchema>,
) {
  return {
    plugin: DatabasePlugin as unknown as PluginConstructor<
      BasePluginConfig,
      DatabasePlugin<TSchema>
    >,
    config,
    name: "database" as const,
  };
}
