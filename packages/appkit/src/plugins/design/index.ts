import type { BasePluginConfig, IAppRouter } from "shared";

import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import { reactSourceLocPlugin } from "../server/react-source-loc-vite-plugin";
import manifest from "./manifest.json";
import { type DesignSelectionInput, DesignSelectionStore } from "./store";
import { designVitePlugin } from "./vite-plugin";

const logger = createLogger("design");

const isDev = () => process.env.NODE_ENV === "development";

/**
 * Dev-only design canvas.
 *
 * In development it contributes a Vite plugin that serves `/design` (a canvas
 * rendering every component exported from `client/src/design/`) and injects
 * the click-to-select picker into every page of the app. Picked elements are
 * POSTed to `/api/design/selection` and persisted to
 * `.appkit/design-selection.json`, where a coding agent picks them up.
 *
 * In any other environment it does nothing except answer `/design` with 404.
 * The manifest is deliberately not `devOnly`: a dropped plugin couldn't claim
 * `/design`, and the SPA fallback would serve the app's index.html for it.
 */
class DesignPlugin extends Plugin<BasePluginConfig> {
  static manifest = defineManifest<"design">(manifest);

  protected static description =
    "Dev-only design canvas and element picker for coding agents";

  private readonly store = new DesignSelectionStore();

  async setup() {
    if (isDev()) return;
    this.context?.addMiddleware("/design", (_req, res) => {
      res.status(404).end();
    });
  }

  /** Consumed by the server plugin when it starts the Vite dev server. */
  vitePlugins() {
    if (!isDev()) return [];
    return [
      designVitePlugin(),
      // Locates component call sites (`<Button>`), which the server's own
      // transform skips because it only tags native elements.
      reactSourceLocPlugin({ projectRoot: process.cwd(), components: true }),
    ];
  }

  injectRoutes(router: IAppRouter): void {
    if (!isDev()) return;

    this.route(router, {
      name: "selection",
      method: "get",
      path: "/selection",
      handler: async (_req, res) => {
        res.json(await this.store.read());
      },
    });

    this.route(router, {
      name: "addSelection",
      method: "post",
      path: "/selection",
      handler: async (req, res) => {
        const body = (req.body ?? {}) as Partial<DesignSelectionInput>;
        if (!Array.isArray(body.elements) || body.elements.length === 0) {
          res.status(400).json({
            ok: false,
            message: "`elements` (non-empty array) is required",
          });
          return;
        }
        const selection = await this.store.add({
          elements: body.elements,
          note: typeof body.note === "string" ? body.note : undefined,
          url: typeof body.url === "string" ? body.url : undefined,
        });
        logger.info("Recorded design selection", {
          id: selection.id,
          elements: selection.elements.length,
        });
        res.json({ ok: true, id: selection.id, file: this.store.filePath });
      },
    });

    this.route(router, {
      name: "clearSelection",
      method: "delete",
      path: "/selection",
      handler: async (_req, res) => {
        await this.store.clear();
        res.json({ ok: true });
      },
    });
  }
}

export const design = toPlugin(DesignPlugin);
