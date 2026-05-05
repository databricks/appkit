import "reflect-metadata";
import { analytics, createApp, lakebase, server } from "@databricks/appkit";
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

createApp({
  plugins: [
    server(),
    reconnect(),
    telemetryExamples(),
    analytics({}),
    lakebase(),
    lakebaseExamples(),
  ],
  ...(process.env.APPKIT_E2E_TEST && { client: createMockClient() }),
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      // ── Lakebase OBO routes (per-user pool, RLS enforced) ──────────

      // GET /api/lakebase-examples/raw/my-products — RLS-filtered list
      app.get("/api/lakebase-examples/raw/my-products", async (req, res) => {
        try {
          const result = await appkit.lakebase
            .asUser(req)
            .query(
              "SELECT * FROM raw_example.products ORDER BY created_at DESC",
            );
          res.json(result.rows);
        } catch (error: unknown) {
          const err = error as Error;
          res.status(500).json({
            error: "Failed to fetch user products",
            message: err.message,
          });
        }
      });

      // POST /api/lakebase-examples/raw/my-products — create as user
      // created_by is set to current_user by the per-user pool's identity
      app.post("/api/lakebase-examples/raw/my-products", async (req, res) => {
        try {
          const { name, category, price, stock } = req.body;

          const result = await appkit.lakebase.asUser(req).query(
            `INSERT INTO raw_example.products (name, category, price, stock, created_by)
                 VALUES ($1, $2, $3, $4, current_user) RETURNING *`,
            [name, category, Number(price), Number(stock)],
          );
          res.json(result.rows[0]);
        } catch (error: unknown) {
          const err = error as Error;
          res.status(500).json({
            error: "Failed to create product",
            message: err.message,
          });
        }
      });

      // ── Analytics examples ──────────

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

      app.get("/whoami", (req, res) => {
        res.json({
          xForwardedUser: req.header("x-forwarded-user") ?? null,
        });
      });
    });
  },
}).catch(console.error);
