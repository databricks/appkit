import { analytics, createApp, server } from "@databricks/appkit";

createApp({
  plugins: [server({ autoStart: false }), analytics({})],
})
  .then((appkit) => {
    appkit.server
      .extend((app) => {
        app.get("/custom", (_req, res) => {
          res.json({ ok: true });
        });
      })
      .start();
  })
  .catch(console.error);
