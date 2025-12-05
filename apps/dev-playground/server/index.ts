import { analytics, createApp, server } from "@databricks/app-kit";
import {
  volumeServing,
  policy,
  type VolumeConfigs,
} from "./plugins/volume-serving-plugin";
import { reconnect } from "./reconnect-plugin";
import { telemetryExamples } from "./telemetry-example-plugin";

// Build plugins array conditionally based on environment
// Log warning if VOLUME_PATH is not configured
if (!process.env.VOLUME_PATH) {
  console.warn(
    "[Server] VOLUME_PATH not configured - volume-serving plugin will not be loaded",
  );
}

const volumeConfigs: VolumeConfigs = {
  images: {
    volumePath: process.env.VOLUME_PATH_IMAGES || "/Volumes/default/images",
    policy: policy.publicRead(),
  },
  home: {
    volumePath: process.env.VOLUME_PATH_HOME || "/Volumes/default/home",
    pathPrefix: "users/", // Internal prefix - public URLs don't include this
    policy: policy.any(
      // Allow download/list of own files
      (action, resource, user) =>
        ["download", "list"].includes(action) &&
        resource.path.startsWith(`/${user.id}/`),
      // Allow upload to own uploads directory
      (action, resource, user) =>
        ["upload", "upsert"].includes(action) &&
        resource.size < 10 * 1024 * 1024 &&
        (resource.mimeType.startsWith("image/") || resource.mimeType.startsWith("video/")) &&
        resource.path.startsWith(`/${user.id}/uploads/`),
    ),
    onAfterUpload: (req, res, resource, user) => {
      console.log("File uploaded successfully", resource, user);
      res.status(200).json({ message: "File uploaded successfully" });
    },
  },
};

const plugins = [
  server(),
  reconnect(),
  telemetryExamples(),
  analytics(),
];

// Only add volume serving plugin if VOLUME_PATH is configured
if (process.env.VOLUME_PATH) {
  plugins.push(volumeServing({ volumeConfigs }));
}

createApp({ plugins });
