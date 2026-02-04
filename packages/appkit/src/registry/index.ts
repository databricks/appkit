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
 * - (Future) Config generators for app.yaml, databricks.yml, .env.example
 */

export { getPluginManifest, getResourceRequirements } from "./manifest-loader";
export { ResourceRegistry } from "./resource-registry";
export * from "./types";
