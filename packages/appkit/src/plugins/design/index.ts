import type { BasePluginConfig } from "shared";

import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import manifest from "./manifest.json";
import { designVitePlugin } from "./vite-plugin";

const isDev = () => process.env.NODE_ENV === "development";

/** Set by a builder's runtime, so a scaffolded `design()` needs no options. */
const BUILDER_ORIGIN_ENV = "APPKIT_DESIGN_BUILDER_ORIGIN";

interface DesignConfig extends BasePluginConfig {
  /**
   * Origin(s) of the app builder that embeds the app, e.g.
   * `"https://builder.example.com"`: the only targets of the ready messages.
   * Bare origins only (`"*"` is rejected). Defaults to the
   * `APPKIT_DESIGN_BUILDER_ORIGIN` environment variable (comma-separated).
   */
  builderOrigin?: string | string[];
}

function parseOrigins(value: DesignConfig["builderOrigin"]): string[] {
  const fromEnv = value === undefined;
  const origins = fromEnv
    ? (process.env[BUILDER_ORIGIN_ENV] ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [value].flat();
  return origins.map((origin) => {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {}
    if (!parsed || parsed.origin === "null" || parsed.origin !== origin) {
      throw new Error(
        `design(): ${fromEnv ? BUILDER_ORIGIN_ENV : "builderOrigin"} "${origin}" must be a bare origin like "https://builder.example.com" ("*" is not allowed)`,
      );
    }
    return origin;
  });
}

/**
 * Dev-only design pages: `/design` (`client/src/design/index.tsx`),
 * `/design/<name>` (`pages/<name>.tsx`), `/design/__stream/<name>` (a draft
 * while it's written) and `GET /design/__status`. Outside development,
 * `/design` answers 404.
 *
 * Not `devOnly` in the manifest: a dropped plugin couldn't claim `/design`, and
 * the SPA fallback would answer it with index.html.
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
