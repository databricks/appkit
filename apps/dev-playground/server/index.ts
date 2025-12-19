import { analytics, createApp, server } from "@databricks/appkit";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

createApp({
  plugins: [server(), reconnect(), telemetryExamples(), analytics({})],
});
