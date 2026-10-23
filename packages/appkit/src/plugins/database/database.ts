import type express from "express";
import pc from "picocolors";
import type { BasePluginConfig, PluginConstructor } from "shared";

import { ServiceContext } from "../../context/service-context";
import {
  DatabasePluginError,
  databaseSetupFailed,
} from "../../database/errors";
import type { Schema } from "../../database/schema-builder";
import { assertFinalizedSchema } from "../../database/schema-builder/define-schema";
import { createLogger } from "../../logging/logger";
import { Plugin } from "../../plugin";
import type { PluginManifest } from "../../registry";
import { assertDatabaseConfig } from "./config";
import type { DatabaseExports } from "./entity-types";
import { createDatabaseState, type DatabaseState } from "./lifecycle";
import { loadDefaultDatabaseSchema } from "./load-schema";
import manifest from "./manifest.json";
import { createActorResolver, selectActorBoundary } from "./operation-actor";
import { validateOperationMetadata } from "./operation-metadata";
import {
  createOperationHandler,
  OPERATIONS_PATH,
  operationPath,
} from "./operation-runtime";
import type {
  DatabaseRoutes,
  LocatedDeclaration,
  OperationAppKit,
  OperationMethod,
} from "./operations";
import type { DefaultDatabaseSchema, IDatabaseConfig } from "./types";

const logger = createLogger("database");

/** The named operations one setup admitted, and the handler that serves them. */
interface ServedOperations {
  /** Declared method by operation name, in registry order. */
  readonly methods: ReadonlyMap<string, OperationMethod>;
  readonly handler: express.RequestHandler;
}

/**
 * The workspace this app is configured for, by the rule
 * `ServiceContext.createCallerContext` applies: `DATABRICKS_HOST`, or in
 * development the host the service client resolved. Never a request header.
 */
async function workspaceHost(): Promise<string | undefined> {
  const configured = process.env.DATABRICKS_HOST;
  if (configured) return configured;
  if (
    process.env.NODE_ENV !== "development" ||
    !ServiceContext.isInitialized()
  ) {
    return undefined;
  }
  return ServiceContext.get()
    .client.getHost()
    .catch(() => undefined);
}

/** `appkit.database` as AppKit core builds it: this plugin's guarded exports. */
function serviceDatabase(
  api: Readonly<Record<string, unknown>>,
): DatabaseExports {
  const db = api.database;
  if (typeof db !== "object" || db === null) {
    throw new DatabasePluginError("INTERNAL", "read");
  }
  return db as DatabaseExports;
}

/**
 * Every sibling's service export, read lazily the way `appkit.<name>` reads
 * it, so one plugin's export never runs for a request that does not use it.
 * `database` is pinned to the request's `db`.
 */
function operationAppKit(
  api: Readonly<Record<string, unknown>>,
  db: DatabaseExports,
): OperationAppKit {
  const appkit: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(api)) {
    if (name === "database") continue;
    Object.defineProperty(appkit, name, {
      enumerable: true,
      get: () => api[name],
    });
  }
  Object.defineProperty(appkit, "database", { enumerable: true, value: db });
  // Each entry is the exports() result PluginMap types for that plugin.
  return Object.freeze(appkit) as OperationAppKit;
}

/** Schema-driven database plugin */
export class DatabasePlugin<
  TSchema extends Schema = DefaultDatabaseSchema,
> extends Plugin<IDatabaseConfig<TSchema>> {
  /** Plugin metadata and required PostgreSQL resource. */
  static manifest = manifest as PluginManifest<"database">;
  declare protected config: IDatabaseConfig<TSchema>;
  private state: DatabaseState | null = null;
  private served: ServedOperations | undefined;
  private setupPromise: Promise<void> | null = null;
  private draining = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(config: IDatabaseConfig<TSchema> = {}) {
    assertDatabaseConfig(config);
    super({ schema: config.schema });
    this.config = {
      schema: config.schema,
      routes: config.routes,
    };
  }

  /** Build and verify one candidate state before publishing its exports. */
  async setup(): Promise<void> {
    if (this.draining || this.state) throw databaseSetupFailed();
    if (!this.setupPromise) {
      const attempt = (async () => {
        const routes = this.config.routes || undefined;
        const schema = routes
          ? await this.routesSchema(routes)
          : this.config.schema === undefined
            ? await loadDefaultDatabaseSchema()
            : this.config.schema;
        try {
          assertFinalizedSchema(schema);
        } catch {
          throw databaseSetupFailed(
            "schema must be a finalized AppKit schema created with defineSchema().",
          );
        }
        // Every declaration is checked before the pool exists.
        const served = routes
          ? await this.serveRoutes(schema, routes)
          : undefined;
        if (this.draining) throw databaseSetupFailed();
        const candidate = await createDatabaseState(
          schema,
          (operation, options) => this.execute(operation, options),
        );
        if (this.draining) {
          // Setup may finish while shutdown is waiting; never publish that state.
          candidate.deactivate();
          await candidate.pool.end().catch(() => undefined);
          throw databaseSetupFailed();
        }
        this.state = candidate;
        this.served = served;
        this.printSummary(schema);
      })();
      this.setupPromise = attempt;
    }
    return this.setupPromise;
  }

  /** The registry's schema; an explicit `schema` must be that same object. */
  private async routesSchema(routes: DatabaseRoutes): Promise<Schema> {
    let schema: Schema;
    try {
      ({ schema } = await routes.schema());
    } catch {
      // Import errors can carry credentials, row values, or application internals.
      throw databaseSetupFailed(
        "Could not load the schema of the database routes registry. Check the schema module and its imports.",
      );
    }
    if (this.config.schema !== undefined && this.config.schema !== schema) {
      throw databaseSetupFailed(
        "database({ schema }) is not the schema the routes registry loads. Omit schema, or pass that same schema.",
      );
    }
    return schema;
  }

  /**
   * Load each routes module in listed order and admit its operations. A
   * declaration without authorization is skipped with a warning; anything
   * malformed or duplicated fails setup.
   */
  private async serveRoutes(
    schema: Schema,
    routes: DatabaseRoutes,
  ): Promise<ServedOperations | undefined> {
    const located: LocatedDeclaration[] = [];
    for (const { file, load } of routes.modules) {
      let exported: [string, unknown][];
      try {
        exported = Object.entries(await load());
      } catch {
        throw databaseSetupFailed(
          `Could not load the database routes module ${JSON.stringify(file)}. Check the module and its imports.`,
        );
      }
      for (const [exportName, value] of exported) {
        located.push({ file, exportName, value });
      }
    }
    const { operations, skipped, errors } = validateOperationMetadata(
      located,
      new Set(Object.keys(schema.$tables)),
    );
    if (errors.length > 0) {
      throw databaseSetupFailed(
        ["invalid database operations:", ...errors.map((e) => e.message)].join(
          "\n  ",
        ),
      );
    }
    for (const issue of skipped) logger.warn("%s", issue.message);
    if (operations.length === 0) return undefined;

    const boundary = selectActorBoundary(await workspaceHost());
    if (boundary.kind === "unsupported") {
      logger.warn(
        "No caller identity can be verified in this deployment, so every database operation answers 401",
      );
    }
    return {
      methods: new Map(
        operations.map(({ name, method }) => [name, method] as const),
      ),
      handler: createOperationHandler({
        schema,
        operations,
        resolveActor: createActorResolver(boundary),
        services: () => {
          const api = this.context?.getServiceApi();
          // Draining, or outside AppKit core: an admitted request fails closed.
          if (!api || this.draining) {
            throw new DatabasePluginError("INTERNAL", "read");
          }
          const db = serviceDatabase(api);
          return { db, appkit: operationAppKit(api, db) };
        },
        telemetry: this.telemetry,
      }),
    };
  }

  /** Serve the admitted operations; without any, register nothing. */
  injectRoutes(router: express.Router): void {
    const served = this.served;
    if (!served) return;
    // The handler reads a body only after it has authenticated the caller.
    this.skipBodyParsingUnder(OPERATIONS_PATH);
    router.use(OPERATIONS_PATH, served.handler);
    for (const name of served.methods.keys()) {
      this.registerEndpoint(name, `/api/database${operationPath(name)}`);
    }
  }

  /** Name every declared table, and every operation HTTP serves, once at boot. */
  private printSummary(schema: Schema): void {
    const names = Object.keys(schema.$tables).sort();
    if (names.length === 0) return;
    const separator = pc.dim("─".repeat(60));
    const rows = names.map((name) => {
      const table = schema.$tables[name];
      const columns = Object.keys(table.$columns).length;
      const relations = table.$relations.length;
      return {
        name,
        columns: `${columns} ${columns === 1 ? "column" : "columns"}`,
        relations: `${relations} ${relations === 1 ? "relation" : "relations"}`,
      };
    });
    const nameWidth = Math.max(...rows.map((r) => r.name.length));
    const columnsWidth = Math.max(...rows.map((r) => r.columns.length));
    const operations = [...(this.served?.methods ?? [])];

    console.log("");
    console.log(`  ${pc.bold("Tables")} ${pc.dim(`(${names.length})`)}`);
    console.log(`  ${separator}`);
    for (const row of rows) {
      const name = pc.bold(row.name.padEnd(nameWidth));
      const columns = pc.dim(row.columns.padEnd(columnsWidth));
      console.log(`  ${name}   ${columns}   ${pc.dim(row.relations)}`);
    }
    if (operations.length > 0) {
      console.log(`  ${separator}`);
      console.log(
        `  ${pc.bold("Operations")} ${pc.dim(`(${operations.length})`)}`,
      );
      console.log(`  ${separator}`);
      for (const [name, method] of operations) {
        console.log(`  ${pc.dim(method.padEnd(6))}   ${pc.bold(name)}`);
      }
    }
    console.log(`  ${separator}`);
    console.log("");
  }

  /**
   * Publish `{ operations: { [name]: method } }` for every served operation.
   * The browser client pairs each method with the endpoint its name
   * registered, and sends nothing for a name absent from both.
   */
  clientConfig(): Record<string, unknown> {
    const served = this.served;
    return served ? { operations: Object.fromEntries(served.methods) } : {};
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
 * Register the database plugin. Pass `routes: databaseRoutes` to serve the
 * generated named operations over HTTP; without it, no database endpoint is
 * registered. Without `routes` or `schema`, setup loads the named `schema`
 * export from the application's `config/database/schema.ts`. Registration
 * itself performs no file or database I/O.
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
