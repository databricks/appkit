import {
  analytics,
  createApp,
  genie,
  multiGenie,
  server,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
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
      spaces: { demo: process.env.GENIE_SPACE_ID ?? "placeholder" },
    }),
    multiGenie({
      genieSpaces: {
        nyctaxi: process.env.NYC_GENIE_SPACE_ID ?? "placeholder",
        bakehouse: process.env.BAKEHOUSE_GENIE_SPACE_ID ?? "placeholder",
      },
      genieSpaceDescriptions: {
        nyctaxi:
          "NYC taxi trip data including trip counts, fares, and locations",
        bakehouse: "Bakehouse sales and product data",
      },
      endpoint: process.env.MULTI_GENIE_ENDPOINT ?? "placeholder",
      model: process.env.MULTI_GENIE_MODEL,
      endpointToken: process.env.MULTI_GENIE_ENDPOINT_TOKEN,
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
