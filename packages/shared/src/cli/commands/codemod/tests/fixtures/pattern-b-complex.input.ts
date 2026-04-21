import { analytics, createApp, server } from "@databricks/appkit";

const appkit = await createApp({
  plugins: [server({ autoStart: false }), analytics({})],
});

appkit.server.extend((app) => {
  app.get("/custom", (_req, res) => {
    res.json({ ok: true });
  });
});

appkit.analytics.query("SELECT 1");

await appkit.server.start();
