import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { createLogger } from "../../logging/logger";
import {
  DATABASE_COLUMNS_FILE,
  DATABASE_TYPES_FILE,
  generateDatabaseTypes,
  SCHEMA_REL,
  type SchemaLoader,
} from "./generator";

const logger = createLogger("type-generator:database:vite-plugin");

export interface AppKitDatabaseTypesPluginOptions {
  /** Output `.d.ts` path relative to project root. Defaults to `shared/appkit-types/database.d.ts`. */
  outFile?: string;
  /** Runtime column metadata output path relative to project root. */
  columnsOutFile?: string;
}

/**
 * Vite plugin — regenerates `shared/appkit-types/database.d.ts` and
 * `shared/appkit-types/database.columns.ts` whenever
 * `config/database/schema.ts` changes during dev. In production
 * (`vite build`) it runs once at `buildStart`.
 *
 * Only activates when `config/database/schema.ts` exists at the Vite root
 * or its parent. Apps without the database plugin pay nothing.
 */
export function appKitDatabaseTypesPlugin(
  options: AppKitDatabaseTypesPluginOptions = {},
): Plugin {
  let projectRoot = process.cwd();
  let outFile = path.resolve(
    projectRoot,
    options.outFile ?? DATABASE_TYPES_FILE,
  );
  let columnsOutFile = path.resolve(
    projectRoot,
    options.columnsOutFile ?? DATABASE_COLUMNS_FILE,
  );
  let schemaFile = path.resolve(projectRoot, SCHEMA_REL);
  let viteServer: ViteDevServer | undefined;

  async function regenerate(): Promise<void> {
    try {
      const server = viteServer;
      const loadModule: SchemaLoader | undefined = server
        ? (schemaPath) =>
            server.ssrLoadModule(schemaPath) as Promise<{
              default: unknown;
            }>
        : undefined;

      await generateDatabaseTypes({
        outFile,
        columnsOutFile,
        projectRoot,
        loadModule,
      });
    } catch (error) {
      if (process.env.NODE_ENV === "production") throw error;
      logger.error("Database type generation failed: %O", error);
      const message =
        error instanceof Error ? `${error.message}` : String(error);
      console.error(
        `[appkit-database-types] Type generation failed: ${message}\n` +
          `  Shared types at "${path.relative(projectRoot, outFile)}" were not updated.\n` +
          `  Fix config/database/schema.ts or run \`appkit db types generate --force\` after.`,
      );
    }
  }

  return {
    name: "appkit-database-types",

    apply(config) {
      const root = path.resolve(config.root ?? process.cwd());
      const probe = path.resolve(root, SCHEMA_REL);
      const probeParent = path.resolve(root, "..", SCHEMA_REL);
      return fs.existsSync(probe) || fs.existsSync(probeParent);
    },

    configResolved(config) {
      const viteRoot = path.resolve(config.root);
      projectRoot = fs.existsSync(path.resolve(viteRoot, SCHEMA_REL))
        ? viteRoot
        : path.resolve(viteRoot, "..");
      outFile = path.resolve(
        projectRoot,
        options.outFile ?? DATABASE_TYPES_FILE,
      );
      columnsOutFile = path.resolve(
        projectRoot,
        options.columnsOutFile ?? DATABASE_COLUMNS_FILE,
      );
      schemaFile = path.resolve(projectRoot, SCHEMA_REL);
    },

    async buildStart() {
      await regenerate();
    },

    transformIndexHtml() {
      if (!fs.existsSync(columnsOutFile)) return [];
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: `import ${JSON.stringify(columnsOutFile)};`,
          injectTo: "head-prepend" as const,
        },
      ];
    },

    configureServer(server) {
      viteServer = server;
      server.watcher.add(schemaFile);
      server.watcher.on("change", async (file) => {
        if (path.resolve(file) !== schemaFile) return;
        logger.info("schema.ts changed; regenerating database types");
        const mod = server.moduleGraph.getModuleById(schemaFile);
        if (mod) server.moduleGraph.invalidateModule(mod);
        await regenerate();
        server.ws.send({ type: "full-reload" });
      });
    },
  };
}
