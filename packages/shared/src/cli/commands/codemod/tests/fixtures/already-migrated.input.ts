import { analytics, createApp, server } from "@databricks/appkit";

createApp({
  plugins: [server(), analytics({})],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get("/custom", (_req, res) => res.json({ ok: true }));
    });
  },
}).catch(console.error);
