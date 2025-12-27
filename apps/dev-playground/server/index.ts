import { analytics, createApp, server } from "@databricks/appkit";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

createApp({
  plugins: [
    server({ autoStart: false }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
  ],
}).then((appkit) => {
  appkit.server
    .extend((app) => {
      // Debug endpoint to inspect headers
      app.get("/debug-headers", (req, res) => {
        const token = req.headers["x-forwarded-access-token"] as string;
        res.json({
          hasToken: !!token,
          tokenLength: token?.length,
          tokenPrefix: token?.substring(0, 30),
          userId: req.headers["x-forwarded-user"],
          allHeaders: Object.keys(req.headers),
        });
      });

      app.get("/sp", (_req, res) => {
        appkit.analytics.query("SELECT 1").then((result) => {
          console.log(result);
          res.json(result);
        });
      });

      app.get("/obo", (req, res) => {
        appkit.analytics
          .asUser(req)
          .query("SELECT 1")
          .then((result) => {
            console.log(result);
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
