import { createApp, server } from "@databricks/appkit";

createApp({
  plugins: [
    server({
      port: 8001,
    }),
  ],
});
