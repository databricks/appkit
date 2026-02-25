import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "../../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Server plugin manifest.
 *
 * The server plugin doesn't require any Databricks resources - it only
 * provides HTTP server functionality and static file serving.
 *
 * @remarks
 * The source of truth for this manifest is `manifest.json` in the same directory.
 * This file loads the JSON and exports it with proper TypeScript typing.
 */
export const serverManifest: PluginManifest = JSON.parse(
  readFileSync(join(__dirname, "manifest.json"), "utf-8"),
) as PluginManifest;
