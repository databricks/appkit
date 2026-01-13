import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { createLogger } from "../logging/logger";
import { generateFromEntryPoint } from "./index";

const logger = createLogger("type-generator:vite-plugin");

/**
 * Options for the AppKit types plugin.
 */
interface AppKitTypesPluginOptions {
  /* Path to the output d.ts file (relative to client folder). */
  outFile?: string;
  /** Folders to watch for changes. */
  watchFolders?: string[];
}

/**
 * Vite plugin to generate types for AppKit queries.
 * Calls generateFromEntryPoint under the hood.
 * @param options - Options to override default values.
 * @returns Vite plugin to generate types for AppKit queries.
 */
export function appKitTypesPlugin(options?: AppKitTypesPluginOptions): Plugin {
  let root: string;
  let outFile: string;
  let watchFolders: string[];

  async function generate() {
    try {
      const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";

      if (!warehouseId) {
        logger.debug("Warehouse ID not found. Skipping type generation.");
        return;
      }

      await generateFromEntryPoint({
        outFile,
        queryFolder: watchFolders[0],
        warehouseId,
        noCache: false,
      });
    } catch (error) {
      // throw in production to fail the build
      if (process.env.NODE_ENV === "production") {
        throw error;
      }
      logger.error("Error generating types: %O", error);
    }
  }

  return {
    name: "appkit-types",

    apply() {
      const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";

      if (!warehouseId) {
        logger.debug("Warehouse ID not found. Skipping type generation.");
        return false;
      }

      if (!fs.existsSync(path.join(process.cwd(), "config", "queries"))) {
        return false;
      }

      return true;
    },

    configResolved(config) {
      root = config.root;
      outFile = path.resolve(root, options?.outFile ?? "src/appKitTypes.d.ts");
      watchFolders = options?.watchFolders ?? [
        path.join(process.cwd(), "config", "queries"),
      ];
    },

    buildStart() {
      generate();
    },

    configureServer(server) {
      server.watcher.add(watchFolders);

      server.watcher.on("change", (changedFile) => {
        const isWatchedFile = watchFolders.some((folder) =>
          changedFile.startsWith(folder),
        );

        if (isWatchedFile && changedFile.endsWith(".sql")) {
          generate();
        }
      });
    },
  };
}
