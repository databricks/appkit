import type express from "express";
import type { IAppRouter, StreamExecutionSettings } from "shared";
import { Plugin, toPlugin } from "../../plugin";
import { GeniePlugin } from "../genie/genie";
import { runAgent } from "./agent";
import { multiGenieStreamDefaults } from "./defaults";
import { multiGenieManifest } from "./manifest";
import type {
  IMultiGenieConfig,
  MultiGenieSendMessageRequest,
  MultiGenieStreamEvent,
} from "./types";

export class MultiGeniePlugin extends Plugin {
  name = "multiGenie";

  static manifest = multiGenieManifest;

  protected static description =
    "Supervisor agent routing questions across multiple Genie spaces";
  protected declare config: IMultiGenieConfig;

  private geniePlugin: GeniePlugin;

  constructor(config: IMultiGenieConfig) {
    super(config);
    this.config = config;
    this.geniePlugin = new GeniePlugin({
      spaces: config.genieSpaces,
      timeout: config.timeout,
    });
  }

  injectRoutes(router: IAppRouter) {
    this.geniePlugin.injectRoutes(router);

    this.route(router, {
      name: "sendMessage",
      method: "post",
      path: "/messages",
      handler: async (req: express.Request, res: express.Response) => {
        await this.asUser(req)._handleSendMessage(req, res);
      },
    });
  }

  async _handleSendMessage(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    const { content } = req.body as MultiGenieSendMessageRequest;

    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const streamSettings: StreamExecutionSettings = {
      ...multiGenieStreamDefaults,
      default: {
        ...multiGenieStreamDefaults.default,
        timeout: Math.max((this.config.timeout ?? 120_000) * 3, 300_000),
      },
    };

    const self = this;

    await this.executeStream<MultiGenieStreamEvent>(
      res,
      async function* (signal) {
        yield* runAgent(content, {
          config: self.config,
          geniePlugin: self.geniePlugin,
          signal,
        });
      },
      streamSettings,
    );
  }

  async sendMessage(content: string): Promise<string> {
    let answer = "";
    for await (const event of runAgent(content, {
      config: this.config,
      geniePlugin: this.geniePlugin,
    })) {
      if (event.type === "answer") {
        answer = event.content;
      }
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }
    return answer;
  }

  async shutdown(): Promise<void> {
    this.streamManager.abortAll();
  }

  exports() {
    return {
      sendMessage: this.sendMessage,
    };
  }
}

export const multiGenie = toPlugin<
  typeof MultiGeniePlugin,
  IMultiGenieConfig,
  "multiGenie"
>(MultiGeniePlugin, "multiGenie");
