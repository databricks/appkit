import type { BasePluginConfig } from "shared";

import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import manifest from "./manifest.json";
import { designVitePlugin } from "./vite-plugin";

const isDev = () => process.env.NODE_ENV === "development";

/**
 * Dev-only design pages.
 *
 * In development it serves `/design` (the default export of
 * `client/src/design/index.tsx`) and `/design/<name>`
 * (`client/src/design/pages/<name>.tsx`) at full size. Elements carry the
 * dev server's `data-source="file:line:col"` attributes, so an inspector can
 * map them back to source.
 *
 * In any other environment it does nothing except answer `/design` with 404.
 * The manifest is deliberately not `devOnly`: a dropped plugin couldn't claim
 * `/design`, and the SPA fallback would serve the app's index.html for it.
 */
class DesignPlugin extends Plugin<BasePluginConfig> {
  static manifest = defineManifest<"design">(manifest);

  protected static description = "Dev-only design pages at /design";

  async setup() {
    if (isDev()) return;
    this.context?.addMiddleware("/design", (_req, res) => {
      res.status(404).end();
    });
  }

  /** Consumed by the server plugin when it starts the Vite dev server. */
  vitePlugins() {
    return isDev() ? [designVitePlugin()] : [];
  }
}

export const design = toPlugin(DesignPlugin);
