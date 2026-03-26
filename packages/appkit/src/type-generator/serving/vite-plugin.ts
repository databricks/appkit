import path from "node:path";
import type { Plugin } from "vite";
import { createLogger } from "../../logging/logger";
import type { EndpointConfig } from "../../plugins/serving/types";
import { generateServingTypes } from "./generator";

const logger = createLogger("type-generator:serving:vite-plugin");

interface AppKitServingTypesPluginOptions {
  /** Path to the output .d.ts file (relative to client root). Default: "src/appKitServingTypes.d.ts" */
  outFile?: string;
  /** Endpoint config. If omitted, reads DATABRICKS_SERVING_ENDPOINT from env. */
  endpoints?: Record<string, EndpointConfig>;
}

/**
 * Vite plugin to generate TypeScript types for AppKit serving endpoints.
 * Fetches OpenAPI schemas from Databricks and generates a .d.ts with
 * ServingEndpointRegistry module augmentation.
 */
export function appKitServingTypesPlugin(
  options?: AppKitServingTypesPluginOptions,
): Plugin {
  let outFile: string;

  async function generate() {
    try {
      await generateServingTypes({
        outFile,
        endpoints: options?.endpoints,
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
      const hasEndpointEnv = !!process.env.DATABRICKS_SERVING_ENDPOINT;
      const hasEndpointsConfig =
        options?.endpoints && Object.keys(options.endpoints).length > 0;

      if (!hasEndpointEnv && !hasEndpointsConfig) {
        logger.debug(
          "No serving endpoints configured. Skipping type generation.",
        );
        return false;
      }

      return true;
    },

    configResolved(config) {
      const root = config.root;
      outFile = path.resolve(
        root,
        options?.outFile ?? "src/appKitServingTypes.d.ts",
      );
    },

    buildStart() {
      generate();
    },

    // No configureServer / watcher — schemas change on endpoint redeploy, not on file edit
  };
}
