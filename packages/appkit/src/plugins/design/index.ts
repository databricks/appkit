import type { BasePluginConfig } from "shared";

import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import manifest from "./manifest.json";
import { designVitePlugin } from "./vite-plugin";

const isDev = () => process.env.NODE_ENV === "development";

interface DesignConfig extends BasePluginConfig {
  /**
   * Origin(s) of the app builder that embeds the app, e.g.
   * `"https://builder.example.com"`. After a design page first paints, an
   * `appkit:design-ready` message is posted to the embedding window
   * (`window.parent`, else `window.opener`), targeted at exactly these
   * origins. `"*"` and anything that isn't a bare origin are rejected.
   */
  builderOrigin?: string | string[];
}

function parseOrigins(value: DesignConfig["builderOrigin"]): string[] {
  return (value === undefined ? [] : [value].flat()).map((origin) => {
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
 * Dev-only design pages.
 *
 * In development it serves `/design` (the default export of
 * `client/src/design/index.tsx`) and `/design/<name>`
 * (`client/src/design/pages/<name>.tsx`) at full size. Elements carry the
 * dev server's `data-source="file:line:col"` attributes, so an inspector can
 * map them back to source. `GET /design/__status` and an
 * `appkit:design-ready` message tell an embedding builder when the design is
 * ready to show (never while it's the template placeholder) and which pages
 * exist. HTML drafts in `drafts/<name>.html` are served at
 * `/design/drafts/<name>`, streamed as they're written, with their
 * `data-appkit` JSON blocks rendered by real appkit-ui components.
 *
 * In any other environment it does nothing except answer `/design` with 404.
 * The manifest is deliberately not `devOnly`: a dropped plugin couldn't claim
 * `/design`, and the SPA fallback would serve the app's index.html for it.
 */
class DesignPlugin extends Plugin<DesignConfig> {
  static manifest = defineManifest<"design">(manifest);

  protected static description = "Dev-only design pages at /design";

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
    return isDev()
      ? [designVitePlugin({ builderOrigins: this.builderOrigins })]
      : [];
  }
}

export const design = toPlugin(DesignPlugin);
