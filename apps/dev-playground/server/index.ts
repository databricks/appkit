import "reflect-metadata";
import {
  agent,
  analytics,
  createApp,
  files,
  genie,
  server,
} from "@databricks/appkit";
import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
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

const wsClient = new WorkspaceClient({});
const endpointName =
  process.env.DATABRICKS_AGENT_ENDPOINT ?? "databricks-claude-sonnet-4-5";

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
      agents: {
        assistant: DatabricksAdapter.fromServingEndpoint({
          workspaceClient: wsClient,
          endpointName,
          systemPrompt:
            "You are a helpful data assistant. Use the available tools to query data and help users with their analysis.",
        }),
        autocomplete: DatabricksAdapter.fromServingEndpoint({
          workspaceClient: wsClient,
          endpointName: "databricks-gemini-3-1-flash-lite",
          systemPrompt: [
            "You are an autocomplete engine.",
            "The user will give you the beginning of a sentence or paragraph.",
            "Continue the text naturally, as if you are the same author.",
            "Do NOT repeat the input. Only output the continuation.",
            "Do NOT use tools. Do NOT explain. Just write the next words.",
          ].join(" "),
          maxSteps: 1,
        }),
      },
      defaultAgent: "assistant",
    }),
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
