import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "../../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const genieManifest: PluginManifest = JSON.parse(
  readFileSync(join(__dirname, "manifest.json"), "utf-8"),
) as PluginManifest;
