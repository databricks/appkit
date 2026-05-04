import {
  getUsernameWithApiLookup,
  Plugin,
  type PluginManifest,
  toPlugin,
} from "@databricks/appkit";
import type { IAppRouter } from "shared";
import * as rawExample from "./lakebase-examples/raw-driver-example";

/**
 * Lakebase Examples Plugin
 *
 * Demonstrates raw pg.Pool driver with OBO (On-Behalf-Of) authentication
 * and Row-Level Security (RLS).
 */

export class LakebaseExamplesPlugin extends Plugin {
  protected envVars: string[] = [];

  static manifest = {
    name: "lakebase-examples",
    displayName: "Lakebase Examples Plugin",
    description: "A plugin that provides lakebase examples",
    resources: {
      required: [],
      optional: [],
    },
  } satisfies PluginManifest<"lakebase-examples">;

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
      await rawExample.setup(user);
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

    rawExample.registerRoutes(router, "/raw");
  }

  async close() {
    await rawExample.cleanup();
  }
}

export const lakebaseExamples = toPlugin(LakebaseExamplesPlugin);
