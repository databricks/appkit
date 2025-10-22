import { Plugin, toPlugin } from "@databricks/apps";
import type {
  IAppRouter,
  StreamExecutionSettings,
} from "@databricks-apps/types";

export class ReconnectPlugin extends Plugin {
  public name = "reconnect";
  public envVars = [];

  injectRoutes(router: IAppRouter): void {
    console.log("Injecting reconnect routes");

    // Simple test endpoint
    router.get("/", (_req, res) => {
      console.log("Reconnected");
      res.json({ message: "Reconnected" });
    });

    // Streaming endpoint: sends 5 messages, one every 3 seconds
    router.get("/stream", async (req, res) => {
      const lastEventId = req.headers["last-event-id"];
      console.log("Starting reconnect stream...", {
        lastEventId,
        allHeaders: req.headers,
      });

      const streamExecutionSettings: StreamExecutionSettings = {
        default: {},
        user: {},
        stream: {
          streamId: "reconnect-test-stream",
          bufferSize: 100,
        },
      };

      // simulate client disconnect
      setInterval(() => {
        req.connection.destroy();
      }, 1000);

      await this.executeStream(
        res,
        async function* (signal) {
          // Send 5 messages, one every 3 seconds
          for (let i = 1; i <= 5; i++) {
            // Check if client disconnected
            if (signal?.aborted) {
              console.log("Stream aborted by client");
              break;
            }

            const message = {
              type: "message",
              count: i,
              total: 5,
              timestamp: new Date().toISOString(),
              content: `Message ${i} of 5`,
            };

            console.log(`Sending message ${i}/5`);
            yield message;

            // Wait 3 seconds before next message (unless it's the last one)
            if (i < 5) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          }

          console.log("Stream completed successfully");
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
