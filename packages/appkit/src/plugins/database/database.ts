import type express from "express";
import type { BasePluginConfig, PluginConstructor } from "shared";

import {
  DatabasePluginError,
  databaseSetupFailed,
} from "../../database/errors";
import type { Schema } from "../../database/schema-builder";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { compileCrudTables } from "./crud/contract";
import { resolveExposedTables } from "./crud/exposure";
import { routeOutcome } from "./crud/response";
import {
  type CrudEntity,
  type CrudOperation,
  type CrudRouteDeps,
  createCreateHandler,
  createDeleteHandler,
  createDetailHandler,
  createListHandler,
  createUpdateHandler,
} from "./crud/routes";
import type { DatabaseExports } from "./entity-types";
import { createDatabaseState, type DatabaseState } from "./lifecycle";
import manifest from "./manifest.json";
import type { DatabaseHooks, IDatabaseConfig } from "./types";

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
  private exposedTables: string[] = [];

  constructor(config: IDatabaseConfig<TSchema>) {
    super({ schema: config.schema });
    this.config = {
      schema: config.schema,
      crudRoutes: config.crudRoutes,
      hooks: config.hooks,
    };
  }

  /** Build and verify one candidate state before publishing its exports. */
  async setup(): Promise<void> {
    if (this.draining || this.state) throw databaseSetupFailed();
    if (!this.setupPromise) {
      const attempt = (async () => {
        this.exposedTables = resolveExposedTables(
          this.config.crudRoutes,
          Object.keys(this.config.schema.$tables),
        );
        // A hook key naming no declared table would silently never run.
        for (const name of Object.keys(this.hooks() ?? {})) {
          if (!Object.hasOwn(this.config.schema.$tables, name)) {
            throw databaseSetupFailed();
          }
        }
        const candidate = await createDatabaseState(
          this.config.schema,
          (operation, options) => this.execute(operation, options),
          this.hooks(),
        );
        if (this.draining) {
          // Setup may finish while shutdown is waiting; never publish that state.
          candidate.deactivate();
          await candidate.pool.end().catch(() => undefined);
          throw databaseSetupFailed();
        }
        this.state = candidate;
      })();
      this.setupPromise = attempt;
    }
    return this.setupPromise;
  }

  /** Register generated routes for explicitly exposed tables only. */
  injectRoutes(router: express.Router): void {
    if (this.exposedTables.length === 0) return;
    const tables = compileCrudTables(
      Object.fromEntries(
        this.exposedTables.map((name) => [
          name,
          this.config.schema.$tables[name],
        ]),
      ),
    );
    const hooks = this.hooks();
    // Every exposed name is a declared table, so its export is an entity client.
    const entities = () =>
      this.exports() as unknown as Record<string, CrudEntity>;

    for (const table of tables.values()) {
      const deps: CrudRouteDeps = {
        table,
        entity: () => entities()[table.name],
        serialize: hooks?.[table.name]?.serialize,
        runRouteSpan: (operation, route, run) =>
          this.runRouteSpan(table.name, operation, route, run),
      };
      this.route(router, {
        name: `${table.name}.list`,
        method: "get",
        path: `/${table.name}`,
        handler: createListHandler(deps),
      });
      this.route(router, {
        name: `${table.name}.create`,
        method: "post",
        path: `/${table.name}`,
        handler: createCreateHandler(deps),
      });
      // Addressing one row needs a key, so a keyless table gets create only.
      if (!table.primaryKey) continue;
      this.route(router, {
        name: `${table.name}.detail`,
        method: "get",
        path: `/${table.name}/:id`,
        handler: createDetailHandler(deps),
      });
      this.route(router, {
        name: `${table.name}.update`,
        method: "patch",
        path: `/${table.name}/:id`,
        handler: createUpdateHandler(deps),
      });
      this.route(router, {
        name: `${table.name}.delete`,
        method: "delete",
        path: `/${table.name}/:id`,
        handler: createDeleteHandler(deps),
      });
    }
  }

  /** Typed hook keys are schema table names, which routing addresses at runtime. */
  private hooks(): DatabaseHooks | undefined {
    return this.config.hooks as DatabaseHooks | undefined;
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

  /** Trace one generated route with allowlisted, low-cardinality attributes. */
  private runRouteSpan(
    table: string,
    operation: CrudOperation,
    route: string,
    run: () => Promise<void>,
  ): Promise<void> {
    return this.telemetry.startActiveSpan(
      "database.crud.route",
      {
        attributes: {
          table_name: table,
          operation,
          "http.route": `/api/${this.name}${route}`,
        },
      },
      async (span) => {
        try {
          await run();
          span.setAttribute("outcome", "success");
        } catch (error) {
          span.setAttribute("outcome", routeOutcome(error));
          throw error;
        } finally {
          span.end();
        }
      },
    );
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
