import type { IAppRouter } from "shared";

import { ServiceContext } from "../../context/service-context";
import { Plugin, toPlugin } from "../../plugin";
import { defineManifest } from "../../registry";
import manifest from "./manifest.json";
import { createDesignerRuntime } from "./server/runtime";

class DesignerPlugin extends Plugin {
  static manifest = defineManifest<"designer">(manifest);
  private runtime?: ReturnType<typeof createDesignerRuntime>;

  async setup() {
    // Designer Jobs and files are App-owned. Forwarded identity is checked by
    // each route; it must not switch these operations to a viewer's credentials.
    this.runtime = createDesignerRuntime(
      ServiceContext.get().client,
      this.config.telemetry,
    );
  }

  injectRoutes(router: IAppRouter) {
    this.runtime?.registerRoutes(router, (config) =>
      this.route(router, config),
    );
  }

  async shutdown() {
    this.runtime?.close();
    this.runtime = undefined;
  }
}

/** Published Lakeflow Designer App runtime (beta). */
export const designer = toPlugin(DesignerPlugin);
