import { createApp, server } from "@databricks/appkit";

createApp({
  plugins: [server({ autoStart: true, port: 3000 })],
}).catch(console.error);
