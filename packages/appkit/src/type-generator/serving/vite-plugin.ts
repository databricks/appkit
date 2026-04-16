import path from "node:path";
import type { Plugin } from "vite";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";
import { generateServingTypes, SERVING_TYPES_FILE, TYPES_DIR } from "../index";
import {
  extractServingEndpoints,
  findServerFile,
} from "./server-file-extractor";

const logger = createLogger("type-generator:serving:vite-plugin");

interface AppKitServingTypesPluginOptions {
  /** Path to the output .d.ts file (relative to client root). Default: "src/appKitServingTypes.d.ts" */
  outFile?: string;
  /** Endpoint config override. If omitted, auto-discovers from the server file or falls back to DATABRICKS_SERVING_ENDPOINT_NAME env var. */
  endpoints?: Record<string, EndpointConfig>;
}

/**
 * Vite plugin to generate TypeScript types for AppKit serving endpoints.
 * Fetches OpenAPI schemas from Databricks and generates a .d.ts with
 * ServingEndpointRegistry module augmentation.
 *
 * Endpoint discovery order:
 * 1. Explicit `endpoints` option (override)
 * 2. AST extraction from server file (server/index.ts or server/server.ts)
 * 3. DATABRICKS_SERVING_ENDPOINT_NAME env var (single default endpoint)
 */
export function appKitServingTypesPlugin(
  options?: AppKitServingTypesPluginOptions,
): Plugin {
  let outFile: string;
  let projectRoot: string;

  async function generate() {
    try {
      // Resolve endpoints: explicit option > server file AST > env var fallback (handled by generator)
      let endpoints = options?.endpoints;
      if (!endpoints) {
        const serverFile = findServerFile(projectRoot);
        if (serverFile) {
          endpoints = extractServingEndpoints(serverFile) ?? undefined;
        }
      }

      await generateServingTypes({
        outFile,
        endpoints,
        noCache: false,
      });
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        throw error;
      }
      logger.error("Error generating serving types: %O", error);
    }
  }

  return {
    name: "appkit-serving-types",

    apply() {
      // Fast checks — no AST parsing here
      if (options?.endpoints && Object.keys(options.endpoints).length > 0) {
        return true;
      }

      if (process.env.DATABRICKS_SERVING_ENDPOINT_NAME) {
        return true;
      }

      // Check if a server file exists (may contain serving() config)
      // Use process.cwd() for apply() since configResolved hasn't run yet
      if (findServerFile(process.cwd())) {
        return true;
      }

      // Also check parent dir (for when cwd is client/)
      const parentDir = path.resolve(process.cwd(), "..");
      if (findServerFile(parentDir)) {
        return true;
      }

      logger.debug(
        "No serving endpoints configured. Skipping type generation.",
      );
      return false;
    },

    configResolved(config) {
      // Resolve project root: go up one level from Vite root (client dir)
      // This handles both:
      // - pnpm dev: process.cwd() is app root, config.root is client/
      // - pnpm build: process.cwd() is client/ (cd client && vite build), config.root is client/
      projectRoot = path.resolve(config.root, "..");
      outFile = path.resolve(
        config.root,
        options?.outFile ?? `src/${TYPES_DIR}/${SERVING_TYPES_FILE}`,
      );
    },

    async buildStart() {
      await generate();
    },

    // No configureServer / watcher — schemas change on endpoint redeploy, not on file edit
  };
}
