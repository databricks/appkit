import { getUsernameWithApiLookup, Plugin, toPlugin } from "@databricks/appkit";
import type { IAppRouter } from "shared";
import * as drizzleExample from "./lakebase-examples/drizzle-example";
import * as rawExample from "./lakebase-examples/raw-driver-example";
import * as sequelizeExample from "./lakebase-examples/sequelize-example";
import * as typeormExample from "./lakebase-examples/typeorm-example";

/**
 * Lakebase Examples Plugin
 *
 * Orchestrates four different approaches to database integration:
 * 1. Raw pg.Pool driver - Direct SQL queries
 * 2. Drizzle ORM - Type-safe schema definitions
 * 3. TypeORM - Entity-based data access
 * 4. Sequelize - Model-based ORM with intuitive API
 *
 * Each example is self-contained and can be used as a reference for
 * implementing Lakebase integration in your own applications.
 */

export class LakebaseExamplesPlugin extends Plugin {
  public name = "lakebase-examples";
  protected envVars: string[] = [];

  static manifest = {
    name: "lakebase-examples",
    displayName: "Lakebase Examples Plugin",
    description: "A plugin that provides lakebase examples",
    resources: {
      required: [],
      optional: [],
    },
  };

  async setup() {
    // Check if Lakebase is configured
    if (!process.env.PGHOST || !process.env.LAKEBASE_ENDPOINT) {
      console.warn(
        "Lakebase not configured (missing PGHOST or LAKEBASE_ENDPOINT), examples disabled",
      );
      return;
    }

    try {
      const user = await getUsernameWithApiLookup();

      // Initialize all four examples in parallel
      await Promise.all([
        rawExample.setup(user),
        drizzleExample.setup(user),
        typeormExample.setup(user),
        sequelizeExample.setup(user),
      ]);
    } catch (error) {
      console.error("Failed to initialize Lakebase examples:", error);
      // Don't throw - allow app to start even if Lakebase examples fail
    }
  }

  injectRoutes(router: IAppRouter): void {
    // Skip route injection if Lakebase is not configured
    if (!process.env.PGHOST || !process.env.LAKEBASE_ENDPOINT) {
      return;
    }

    // Register routes for each example under /api/lakebase-examples/*
    rawExample.registerRoutes(router, "/raw");
    drizzleExample.registerRoutes(router, "/drizzle");
    typeormExample.registerRoutes(router, "/typeorm");
    sequelizeExample.registerRoutes(router, "/sequelize");
  }

  async close() {
    await Promise.all([
      rawExample.cleanup(),
      drizzleExample.cleanup(),
      typeormExample.cleanup(),
      sequelizeExample.cleanup(),
    ]);
  }
}

export const lakebaseExamples = toPlugin<
  typeof LakebaseExamplesPlugin,
  Record<string, never>,
  "lakebase-examples"
>(LakebaseExamplesPlugin, "lakebase-examples");
