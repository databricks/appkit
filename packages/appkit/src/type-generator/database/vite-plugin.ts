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
      // Production: fail the build loudly — a broken type generation there
      // would ship wrong types to downstream consumers.
      if (process.env.NODE_ENV === "production") throw error;
      // Dev: don't kill the dev server (HMR must survive a temporarily
      // broken schema.ts), but make the failure visible in the terminal.
      // Previously this went through `logger.error`, which routed to pino's
      // file transport under some configs and swallowed the message; users
      // saw "db.* isn't typed" with no hint why. Surface on stderr so it
      // shows up next to Vite's own startup logs.
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

    apply() {
      // Activation gate is intentionally filesystem-based — reading the schema
      // would force a tsx load before Vite is ready.
      const cwd = process.cwd();
      const probe = path.resolve(cwd, SCHEMA_REL);
      const probeParent = path.resolve(cwd, "..", SCHEMA_REL);
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
      schemaFile = path.resolve(projectRoot, SCHEMA_REL);
    },

    async buildStart() {
      // `generator.ts` re-writes the `.d.ts` even on cache HIT, so a regen
      // on every `buildStart` is enough to heal after `git clean -fdX` or
      // manual deletion of the gitignored output file.
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
