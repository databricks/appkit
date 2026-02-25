import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "../../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Analytics plugin manifest.
 *
 * The analytics plugin requires a SQL Warehouse for executing queries
 * against Databricks data sources.
 *
 * @remarks
 * The source of truth for this manifest is `manifest.json` in the same directory.
 * This file loads the JSON and exports it with proper TypeScript typing.
 */
export const analyticsManifest: PluginManifest = JSON.parse(
  readFileSync(join(__dirname, "manifest.json"), "utf-8"),
) as PluginManifest;
