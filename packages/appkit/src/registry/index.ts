/**
 * Resource Registry System
 *
 * The registry system enables plugins to declare their Databricks resource
 * requirements (SQL Warehouses, Lakebase instances, etc.) in a standardized way.
 *
 * Components:
 * - Type definitions for resources, manifests, and validation
 * - Manifest loader for reading plugin declarations
 * - ResourceRegistry singleton for tracking requirements across all plugins
 * - JSON Schema for validating plugin manifests
 * - (Future) Config generators for app.yaml, databricks.yml, .env.example
 */

export { getPluginManifest, getResourceRequirements } from "./manifest-loader";
export { ResourceRegistry } from "./resource-registry";
export * from "./types";

/**
 * URL to the plugin manifest JSON Schema hosted on GitHub Pages.
 * Can be used for validation or referenced in manifest files.
 *
 * @example
 * ```json
 * {
 *   "$schema": "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
 *   "name": "my-plugin",
 *   ...
 * }
 * ```
 */
// TODO: We may want to open a PR to https://github.com/SchemaStore/schemastore
// export const MANIFEST_SCHEMA_ID =
//   "https://json.schemastore.org/databricks-appkit-plugin-manifest.json";
const _MANIFEST_SCHEMA_ID =
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json";
