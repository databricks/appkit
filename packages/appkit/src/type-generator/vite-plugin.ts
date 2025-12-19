import { execSync } from "node:child_process";
import path from "node:path";
import type { Plugin } from "vite";

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
 * Calls `npx appkit-generate-types` under the hood.
 * @param options - Options to override default values.
 * @returns Vite plugin to generate types for AppKit queries.
 */
export function appKitTypesPlugin(options?: AppKitTypesPluginOptions): Plugin {
  let root: string;
  let appRoot: string;
  let outFile: string;
  let watchFolders: string[];

  function generate() {
    try {
      const args = [appRoot, outFile].join(" ");
      execSync(`npx appkit-generate-types ${args}`, {
        cwd: appRoot,
        stdio: "inherit",
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
      appRoot = path.resolve(root, "..");

      outFile = path.resolve(root, options?.outFile ?? "src/appKitTypes.d.ts");

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
    },
  };
}
