import "reflect-metadata";
import {
  agent,
  analytics,
  createApp,
  files,
  genie,
  server,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { demoTools } from "./agent-tools";
import { lakebaseExamples } from "./lakebase-examples-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

function createMockClient() {
  const client = new WorkspaceClient({
    host: "http://localhost",
    token: "e2e",
    authType: "pat",
  });
  client.currentUser.me = async () => ({ id: "e2e-test-user" });
  return client;
}

createApp({
  plugins: [
    server({ autoStart: false }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    genie({
      spaces: { demo: process.env.DATABRICKS_GENIE_SPACE_ID ?? "placeholder" },
    }),
    lakebaseExamples(),
    files(),
    agent({
      model: process.env.DATABRICKS_MODEL || "databricks-claude-sonnet-4-5",
      systemPrompt:
        "You are a helpful assistant. Use tools when appropriate — for example, use get_weather for weather questions, and get_current_time for time queries.",
      tools: [demoTools.weatherTool],
    }),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
}).then(async (appkit) => {
  // Add tools after app creation
  await appkit.agent.addTools([demoTools.timeTool]);

  appkit.server
    .extend((app) => {
      // Rewrite to use standard Databricks Apps convention: /invocations at root
      app.post("/invocations", (req, res) => {
        req.url = "/api/agent";
        app(req, res);
      });

      app.get("/sp", (_req, res) => {
        appkit.analytics
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });

      app.get("/obo", (req, res) => {
        appkit.analytics
          .asUser(req)
          .query("SELECT * FROM samples.nyctaxi.trips;")
          .then((result) => {
            console.log(result[0]);
            res.json(result);
          })
          .catch((error) => {
            console.error("OBO Error:", error);
            res.status(500).json({
              error: error.message,
              errorCode: error.errorCode,
              statusCode: error.statusCode,
            });
          });
      });
    })
    .start();
});
