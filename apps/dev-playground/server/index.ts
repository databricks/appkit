import { analytics, createApp, server } from "@databricks/app-kit";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

createApp({
  plugins: [
    server({
      port: Number(process.env.DATABRICKS_APP_PORT) || 8001,
    }),
    reconnect(),
    telemetryExamples(),
    analytics({}),
  ],
});
