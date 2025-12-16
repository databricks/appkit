import { analytics, createApp, server } from "@databricks/app-kit";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

createApp({
  plugins: [server(), reconnect(), telemetryExamples(), analytics({})],
});
