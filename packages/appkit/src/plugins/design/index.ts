import path from "node:path";

import type { BasePluginConfig, IAppRouter } from "shared";

import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import { reactSourceLocPlugin } from "../server/react-source-loc-vite-plugin";
import manifest from "./manifest.json";
import {
  type DesignSelectionInput,
  DesignSelectionStore,
  SCREENSHOT_NAME,
} from "./store";
import { designVitePlugin } from "./vite-plugin";

const logger = createLogger("design");

const isDev = () => process.env.NODE_ENV === "development";

interface DesignConfig extends BasePluginConfig {
  /**
   * Origin(s) of the app builder that embeds the app, e.g.
   * `"https://builder.example.com"`. When `/design` runs inside that window
   * (as an iframe, or opened by it), each send is also posted to it with
   * `window.postMessage`, targeted at exactly these origins. `"*"` and
   * anything that isn't a bare origin are rejected.
   */
  builderOrigin?: string | string[];
}

function parseOrigins(value: DesignConfig["builderOrigin"]): string[] {
  const list = value === undefined ? [] : [value].flat();
  return list.map((origin) => {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {}
    if (!parsed || parsed.origin === "null" || parsed.origin !== origin) {
      throw new Error(
        `design(): builderOrigin "${origin}" must be a bare origin like "https://builder.example.com" ("*" is not allowed)`,
      );
    }
    return origin;
  });
}

/**
 * Dev-only design canvas.
 *
 * In development it contributes a Vite plugin that serves `/design` (a canvas
 * rendering every component exported from `client/src/design/`, with a
 * click-to-select picker). Each send is persisted through
 * `/api/design/selection` to `.appkit/design-selection.json`, and, when the
 * canvas is embedded by an allowed app builder (`builderOrigin`), also posted
 * to that window as an `appkit:design-selection` message.
 *
 * In any other environment it does nothing except answer `/design` with 404.
 * The manifest is deliberately not `devOnly`: a dropped plugin couldn't claim
 * `/design`, and the SPA fallback would serve the app's index.html for it.
 */
class DesignPlugin extends Plugin<DesignConfig> {
  static manifest = defineManifest<"design">(manifest);

  protected static description =
    "Dev-only design canvas and element picker for coding agents";

  private readonly store = new DesignSelectionStore();
  private readonly builderOrigins: string[];

  constructor(config: DesignConfig = {} as DesignConfig) {
    super(config);
    this.builderOrigins = parseOrigins(config.builderOrigin);
  }

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
      designVitePlugin({ builderOrigins: this.builderOrigins }),
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
        res.json({ ok: true, selection, file: this.store.filePath });
      },
    });

    this.route(router, {
      name: "screenshot",
      method: "get",
      path: "/screenshots/:name",
      handler: async (req, res) => {
        const name = String(req.params.name);
        if (!SCREENSHOT_NAME.test(name)) {
          res.status(404).end();
          return;
        }
        res.sendFile(path.join(this.store.screenshotDir, name), (error) => {
          if (error && !res.headersSent) res.status(404).end();
        });
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
