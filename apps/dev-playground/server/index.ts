import { analytics, createApp, server } from "@databricks/app-kit";
import { reconnect } from "./reconnect-plugin";

createApp({
  plugins: [server(), reconnect(), analytics()],
});
