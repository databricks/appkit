import { Plugin, toPlugin } from "@databricks/app-kit";
import type { IAppRouter, StreamExecutionSettings } from "shared";

export class ReconnectPlugin extends Plugin {
  public name = "reconnect";
  public envVars = [];

  injectRoutes(router: IAppRouter): void {
    router.get("/", (_req, res) => {
      res.json({ message: "Reconnected" });
    });

    router.get("/stream", async (req, res) => {
      const sessionId =
        (req.query.sessionId as string) || `session-${Date.now()}`;
      const streamId = `reconnect-test-stream-${sessionId}`;

      const streamExecutionSettings: StreamExecutionSettings = {
        default: {},
        user: {},
        stream: {
          streamId: streamId,
          bufferSize: 100,
        },
      };

      await this.executeStream(
        res,
        async function* (signal) {
          for (let i = 1; i <= 5; i++) {
            if (signal?.aborted) {
              break;
            }

            const message = {
              type: "message",
              count: i,
              total: 5,
              timestamp: new Date().toISOString(),
              content: `Message ${i} of 5`,
            };

            yield message;

            if (i < 5) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          }
        },
        streamExecutionSettings,
      );
    });
  }
}

export const reconnect = toPlugin<
  typeof ReconnectPlugin,
  Record<string, never>,
  "reconnect"
>(ReconnectPlugin, "reconnect");
