import { analytics, createApp, server } from "@databricks/appkit";

const appkit = await createApp({
  plugins: [server({ autoStart: false }), analytics({})],
});

appkit.server.extend((app) => {
  app.get("/one", (_req, res) => res.json({ route: 1 }));
});

appkit.server.extend((app) => {
  app.get("/two", (_req, res) => res.json({ route: 2 }));
});

await appkit.server.start();
