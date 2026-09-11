import type express from "express";
import type { BasePluginConfig, PluginConstructor } from "shared";

import {
  DatabasePluginError,
  databaseSetupFailed,
} from "../../database/errors";
import type { Schema } from "../../database/schema-builder";
import { assertFinalizedSchema } from "../../database/schema-builder/define-schema";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { assertDatabaseConfig } from "./config";
import { compileCrudTables } from "./crud/contract";
import { type CrudExposure, resolveCrudExposure } from "./crud/exposure";
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
import { loadDefaultDatabaseSchema } from "./load-schema";
import manifest from "./manifest.json";
import type {
  DatabaseHooks,
  DefaultDatabaseSchema,
  IDatabaseConfig,
} from "./types";

/** Schema-driven database plugin */
export class DatabasePlugin<
  TSchema extends Schema = DefaultDatabaseSchema,
> extends Plugin<IDatabaseConfig<TSchema>> {
  /** Plugin metadata and required PostgreSQL resource. */
  static manifest = manifest as PluginManifest<"database">;
  declare protected config: IDatabaseConfig<TSchema>;
  private state: DatabaseState | null = null;
  private setupPromise: Promise<void> | null = null;
  private draining = false;
  private shutdownPromise: Promise<void> | null = null;
  private exposure: CrudExposure = { tables: [], writes: new Map() };
  private resolvedSchema: Schema | null = null;

  constructor(config: IDatabaseConfig<TSchema> = {}) {
    assertDatabaseConfig(config);
    super({ schema: config.schema });
    this.config = {
      schema: config.schema,
      api: config.api,
      hooks: config.hooks,
    };
  }

  /** Build and verify one candidate state before publishing its exports. */
  async setup(): Promise<void> {
    if (this.draining || this.state) throw databaseSetupFailed();
    if (!this.setupPromise) {
      const attempt = (async () => {
        const schema =
          this.config.schema === undefined
            ? await loadDefaultDatabaseSchema()
            : this.config.schema;
        try {
          assertFinalizedSchema(schema);
        } catch {
          throw databaseSetupFailed(
            "schema must be a finalized AppKit schema created with defineSchema().",
          );
        }
        if (this.draining) throw databaseSetupFailed();
        const exposure = resolveCrudExposure(
          this.config.api,
          Object.keys(schema.$tables),
        );
        // A hook key naming no declared table would silently never run.
        for (const name of Object.keys(this.hooks() ?? {})) {
          if (!Object.hasOwn(schema.$tables, name)) {
            throw databaseSetupFailed(
              `hooks names undeclared table ${JSON.stringify(name)}. Use a table declared in schema.`,
            );
          }
        }
        const candidate = await createDatabaseState(
          schema,
          (operation, options) => this.execute(operation, options),
          this.hooks(),
        );
        if (this.draining) {
          // Setup may finish while shutdown is waiting; never publish that state.
          candidate.deactivate();
          await candidate.pool.end().catch(() => undefined);
          throw databaseSetupFailed();
        }
        this.resolvedSchema = schema;
        this.exposure = exposure;
        this.state = candidate;
      })();
      this.setupPromise = attempt;
    }
    return this.setupPromise;
  }

  /** Register generated CRUD, subject to the configured table and write restrictions. */
  injectRoutes(router: express.Router): void {
    if (this.exposure.tables.length === 0) return;
    const schema = this.resolvedSchema;
    if (!schema) throw databaseSetupFailed();
    const tables = compileCrudTables(
      Object.fromEntries(
        this.exposure.tables.map((name) => [name, schema.$tables[name]]),
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
      const writes = this.exposure.writes.get(table.name);
      if (writes?.has("create")) {
        this.route(router, {
          name: `${table.name}.create`,
          method: "post",
          path: `/${table.name}`,
          handler: createCreateHandler(deps),
        });
      }
      // Addressing one row needs a public key.
      if (!table.primaryKey) continue;
      this.route(router, {
        name: `${table.name}.detail`,
        method: "get",
        path: `/${table.name}/:id`,
        handler: createDetailHandler(deps),
      });
      if (writes?.has("update")) {
        this.route(router, {
          name: `${table.name}.update`,
          method: "patch",
          path: `/${table.name}/:id`,
          handler: createUpdateHandler(deps),
        });
      }
      if (writes?.has("delete")) {
        this.route(router, {
          name: `${table.name}.delete`,
          method: "delete",
          path: `/${table.name}/:id`,
          handler: createDeleteHandler(deps),
        });
      }
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

type DatabaseRegistration<TSchema extends Schema> = {
  plugin: PluginConstructor<BasePluginConfig, DatabasePlugin<TSchema>>;
  config: IDatabaseConfig<TSchema>;
  name: "database";
};

/**
 * Create the database plugin. Omit configuration to load
 * `config/database/schema.ts`, or supply a typed schema override.
 */
export function database<TSchema extends Schema>(
  config: IDatabaseConfig<TSchema> & { readonly schema: TSchema },
): DatabaseRegistration<TSchema> & {
  config: IDatabaseConfig<TSchema> & { readonly schema: TSchema };
};
/**
 * Register the database plugin with opinionated defaults and full HTTP CRUD.
 * By default, setup loads the named `schema` export from the application's
 * `config/database/schema.ts`. Registration itself performs no file or database I/O.
 */
export function database<TSchema extends Schema = DefaultDatabaseSchema>(
  config?: IDatabaseConfig<TSchema>,
): DatabaseRegistration<TSchema>;
export function database<TSchema extends Schema = DefaultDatabaseSchema>(
  config: IDatabaseConfig<TSchema> = {},
): DatabaseRegistration<TSchema> {
  assertDatabaseConfig(config);
  return {
    plugin: DatabasePlugin as unknown as PluginConstructor<
      BasePluginConfig,
      DatabasePlugin<TSchema>
    >,
    config,
    name: "database" as const,
  };
}
