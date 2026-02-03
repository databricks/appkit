/**
 * Resource Registry System
 *
 * The registry system enables plugins to declare their Databricks resource
 * requirements (SQL Warehouses, Lakebase instances, etc.) in a standardized way.
 *
 * Components:
 * - Type definitions for resources, manifests, and validation
 * - (Future) ResourceRegistry singleton for tracking requirements
 * - (Future) Manifest loader for reading plugin declarations
 * - (Future) Config generators for app.yaml, databricks.yml, .env.example
 */

export * from "./types";
