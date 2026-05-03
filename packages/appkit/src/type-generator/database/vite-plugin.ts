import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { createLogger } from "../../logging/logger";
import {
  DATABASE_TYPES_FILE,
  generateDatabaseTypes,
  SCHEMA_REL,
  type SchemaLoader,
} from "./generator";

const logger = createLogger("type-generator:database:vite-plugin");

export interface AppKitDatabaseTypesPluginOptions {
  /** Output `.d.ts` path relative to project root. Defaults to `shared/appkit-types/database.d.ts`. */
  outFile?: string;
}

/**
 * Vite plugin — regenerates `shared/appkit-types/database.d.ts` whenever
 * `config/database/schema.ts` changes during dev. In production (`vite build`)
 * it runs once at `buildStart`.
 *
 * **Activation gate:** only when `config/database/schema.ts` exists, either at
 * the Vite root or its parent. Apps without a database plugin pay nothing.
 *
 * **Dev path (decision #25):** while the dev server is running, the schema is
 * loaded via `server.ssrLoadModule` — Vite evaluates it in-process, same Node
 * runtime. No child spawn, no `tsx` cold start. Before a change triggers
 * regeneration, the module cache is invalidated so the next load sees fresh
 * source.
 *
 * **Production path:** `buildStart` runs before `configureServer`, so the
 * loader falls through to the default dynamic `import()` — relying on the
 * parent process's tsx loader for TS support.
 */
export function appKitDatabaseTypesPlugin(
  options: AppKitDatabaseTypesPluginOptions = {},
): Plugin {
  let projectRoot = process.cwd();
  let outFile = path.resolve(
    projectRoot,
    options.outFile ?? DATABASE_TYPES_FILE,
  );
  let schemaFile = path.resolve(projectRoot, SCHEMA_REL);
  let viteServer: ViteDevServer | undefined;

  async function regenerate(): Promise<void> {
    try {
      const loadModule: SchemaLoader | undefined = viteServer
        ? (schemaPath) =>
            viteServer!.ssrLoadModule(schemaPath) as Promise<{
              default: unknown;
            }>
        : undefined;

      await generateDatabaseTypes({
        outFile,
        projectRoot,
        loadModule,
      });
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      logger.error("Database type generation failed: %O", error);
    }
  }

  return {
    name: "appkit-database-types",

    apply() {
      // Activation gate is intentionally filesystem-based — reading the schema
      // would force a tsx load before Vite is ready.
      const cwd = process.cwd();
      const probe = path.resolve(cwd, SCHEMA_REL);
      const probeParent = path.resolve(cwd, "..", SCHEMA_REL);
      return fs.existsSync(probe) || fs.existsSync(probeParent);
    },

    configResolved(config) {
      // When Vite runs from client/ (cd client && vite build), the project
      // root is the parent directory; when Vite runs from the app root the
      // client/ is a subdir. Resolving from config.root handles both shapes.
      projectRoot = path.resolve(config.root, "..");
      outFile = path.resolve(
        projectRoot,
        options.outFile ?? DATABASE_TYPES_FILE,
      );
      schemaFile = path.resolve(projectRoot, SCHEMA_REL);
    },

    async buildStart() {
      await regenerate();
    },

    configureServer(server) {
      viteServer = server;
      server.watcher.add(schemaFile);
      server.watcher.on("change", async (file) => {
        if (path.resolve(file) !== schemaFile) return;
        logger.info("schema.ts changed; regenerating database types");
        // Invalidate Vite's cache so ssrLoadModule re-evaluates fresh source.
        const mod = server.moduleGraph.getModuleById(schemaFile);
        if (mod) server.moduleGraph.invalidateModule(mod);
        await regenerate();
      });
    },
  };
}
