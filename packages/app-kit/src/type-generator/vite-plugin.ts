import path from "node:path";
import type { Plugin } from "vite";
import { generateFromEntryPoint } from "./index";

/**
 * Options for the AppKit types plugin.
 */
interface AppKitTypesPluginOptions {
  /** Path to the output d.ts file (relative to client folder). */
  outFile?: string;
  /** Folders to watch for changes. */
  watchFolders?: string[];
  /**
   * Server URL to fetch plugin endpoints from.
   * Used to generate typed API client.
   * @default "http://localhost:8000" in development
   */
  serverUrl?: string;
}

const DEFAULT_SERVER_URL = "http://localhost:8000";

/**
 * Vite plugin to generate types for AppKit queries and plugin endpoints.
 *
 * Features:
 * - Generates QueryRegistry types from SQL files
 * - Generates AppKitPlugins types from server plugin endpoints
 * - Watches for SQL file changes and regenerates
 * - In dev mode, fetches plugin schema after server starts
 *
 * @param options - Options to override default values.
 * @returns Vite plugin to generate types for AppKit queries.
 */
export function appKitTypesPlugin(options?: AppKitTypesPluginOptions): Plugin {
  let root: string;
  let outFile: string;
  let watchFolders: string[];
  let serverUrl: string;

  async function generate() {
    try {
      await generateFromEntryPoint({
        outFile,
        queryFolder: watchFolders[0],
        warehouseId: process.env.DATABRICKS_WAREHOUSE_ID || "",
        serverUrl,
        noCache: false,
      });
    } catch (error) {
      // throw in production to fail the build
      if (process.env.NODE_ENV === "production") {
        throw error;
      }
      console.error("[AppKit] Error generating types:", error);
    }
  }

  return {
    name: "appkit-types",

    configResolved(config) {
      root = config.root;

      outFile = path.resolve(root, options?.outFile ?? "src/appKitTypes.d.ts");
      serverUrl =
        options?.serverUrl ||
        process.env.APPKIT_SERVER_URL ||
        DEFAULT_SERVER_URL;

      watchFolders = (options?.watchFolders ?? ["../config/queries"]).map(
        (folder) => path.resolve(root, folder),
      );
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

      server.watcher.on("ready", async () => {
        generate();
      });
    },
  };
}
