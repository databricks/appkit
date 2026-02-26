import "reflect-metadata";
import {
  agent,
  analytics,
  chatUI,
  createApp,
  server,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
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

// Example: agent + chat UI (disabled by default; set ENABLE_AGENT_EXAMPLE=true to activate)
const agentPlugins =
  process.env.ENABLE_AGENT_EXAMPLE === "true"
    ? [
        agent({
          // model: 'databricks-claude-sonnet-4-5',  // or set DATABRICKS_AGENT_SERVING_ENDPOINT_NAME
          systemPrompt: "You are a helpful Databricks data assistant.",
        }),
        chatUI({ enablePersistence: false }),
      ]
    : [];

createApp({
  plugins: [
    server({ autoStart: false }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    lakebaseExamples(),
    ...agentPlugins,
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
}).then((appkit) => {
  appkit.server
    .extend((app) => {
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
