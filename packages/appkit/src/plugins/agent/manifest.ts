import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "../../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Agent plugin manifest.
 *
 * The agent plugin requires a Databricks model serving endpoint to run
 * the LangChain/LangGraph agent, and optionally an MLflow experiment
 * for trace collection.
 *
 * @remarks
 * The source of truth for this manifest is `manifest.json` in the same directory.
 * This file loads the JSON and exports it with proper TypeScript typing.
 */
export const agentManifest: PluginManifest = JSON.parse(
  readFileSync(join(__dirname, "manifest.json"), "utf-8"),
) as PluginManifest;
