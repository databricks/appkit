import { analytics, createApp, server } from "@databricks/app-kit";
import { volumeServing } from "./plugins/volume-serving-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

// Build plugins array conditionally based on environment
// Log warning if VOLUME_PATH is not configured
if (!process.env.VOLUME_PATH) {
  console.warn(
    "[Server] VOLUME_PATH not configured - volume-serving plugin will not be loaded",
  );
}

createApp({
  plugins: [
    server(),
    reconnect(),
    telemetryExamples(),
    analytics(),
    // Only add volume serving plugin if VOLUME_PATH is configured
    ...(process.env.VOLUME_PATH
      ? [
          volumeServing({
            volumePath: process.env.VOLUME_PATH,
            enableDirectoryListing: true,
          }),
        ]
      : []),
  ],
});
