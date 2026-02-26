/**
 * ChatUIPlugin — mounts the e2e-chatbot-app-next UI as a sub-application.
 *
 * Ported from ~/app-templates/agent-langchain-ts/src/framework/plugins/ui/UIPlugin.ts
 */

import type express from "express";
import { createLogger } from "../../logging/logger";
import { Plugin, toPlugin } from "../../plugin";
import { chatUIManifest } from "./manifest";
import type { IChatUIConfig } from "./types";

const logger = createLogger("chatUI");

export class ChatUIPlugin extends Plugin<IChatUIConfig> {
  public name = "chatUI" as const;

  /** Plugin manifest declaring metadata and resource requirements */
  static manifest = chatUIManifest;

  protected declare config: IChatUIConfig;

  private uiApp: express.Application | null = null;

  /**
   * Config-dependent resource requirements:
   * when enablePersistence is true, the DATABASE resource becomes required.
   */
  static getResourceRequirements(config: IChatUIConfig) {
    if (!config.enablePersistence) return [];
    return [
      {
        type: "database" as const,
        alias: "Chat History DB",
        resourceKey: "chat-history-database",
        description: "Lakebase PostgreSQL database for persistent chat history",
        permission: "CAN_CONNECT_AND_CREATE" as const,
        fields: {
          instance_name: { env: "DATABRICKS_CHATDB_INSTANCE" },
          database_name: { env: "DATABRICKS_CHATDB_NAME" },
        },
        required: true,
      },
    ];
  }

  async setup() {
    // Tell the chatbot server which agent endpoint to proxy chat requests to
    process.env.API_PROXY = this.config.agentEndpoint ?? "/api/agent";

    // Resolve the path to the chatbot server module
    let uiServerPath = this.config.uiServerPath;
    if (!uiServerPath) {
      try {
        uiServerPath = require.resolve("@databricks/chatbot-ui/server");
      } catch {
        logger.warn(
          "ChatUIPlugin: @databricks/chatbot-ui/server not found. " +
            "Install the chatbot-ui package or provide config.uiServerPath.",
        );
        return;
      }
    }

    try {
      // Prevent the UI server from auto-starting when imported as a module
      process.env.UI_AUTO_START = "false";

      const mod = await import(uiServerPath);
      this.uiApp = mod.default as express.Application;
      logger.info("ChatUIPlugin: UI app loaded from %s", uiServerPath);
    } catch (err) {
      logger.warn(
        "ChatUIPlugin: could not load UI app from %s — %O",
        uiServerPath,
        err,
      );
      this.uiApp = null;
    }
  }

  injectRoutes(router: express.Router) {
    if (this.uiApp) {
      // Mount the chatbot Express app's routes:
      // /api/chat, /api/history, /api/session, etc.
      // Static client (React build) is served by ServerPlugin's StaticServer.
      router.use(this.uiApp);
    } else {
      logger.warn("ChatUIPlugin: no UI app available — routes not injected.");
    }
  }
}

export const chatUI = toPlugin<typeof ChatUIPlugin, IChatUIConfig, "chatUI">(
  ChatUIPlugin,
  "chatUI",
);
