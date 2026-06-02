/**
 * Wrapper types — interface for the AppKit workspace client and type
 * re-exports used across the codebase.
 *
 * Modular SDK service clients (`files`, `warehouses`, `vectorSearch`,
 * `genie`, `jobs`) are sourced from `@databricks/sdk-<service>`. Services
 * without a modular package yet (`statementExecution`, `servingEndpoints`,
 * `currentUser`) are typed against the legacy SDK and delegated through
 * `toLegacyWorkspaceClient()`.
 *
 * Type-namespace re-exports (`files`, `iam`, `jobs`, `serving`, `sql`)
 * still point at `@databricks/sdk-experimental` to keep existing AppKit
 * call-site shapes (snake_case fields, public type identities) stable.
 * The migrated connectors translate between camelCase modular SDK
 * payloads/responses and these legacy-shaped public types at the
 * boundary.
 */
import type { Config as LegacyConfig } from "@databricks/sdk-experimental";
import type { FilesClient } from "@databricks/sdk-files/v2";
import type { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
import type { WarehousesClient } from "@databricks/sdk-warehouses/v1";

import type { AppKitHttpClient } from "./http";
import type { LegacyWorkspaceClient } from "./legacy";

/**
 * Re-exported type namespaces. Same shapes as the old SDK for now.
 *
 * TODO(prod): switch each namespace to the modular `@databricks/sdk-<service>`
 * model exports and audit field-name changes (snake_case → camelCase) in
 * AppKit's public type surface (`DirectoryEntry`, `DownloadResponse`, etc.).
 */
// `iam` is intentionally omitted from this re-export — AppKit doesn't
// touch the IAM namespace directly anywhere (knip flagged it as unused).
// Add back if a connector starts using `iam.User`, etc.
export type {
  files,
  jobs,
  serving,
  sql,
} from "@databricks/sdk-experimental";

/**
 * The wrapper's facade type. Migrated services use modular SDK clients
 * directly; legacy delegates are explicitly marked.
 */
export interface WorkspaceClient {
  /** UC Volumes / Files API — `@databricks/sdk-files`. */
  readonly files: FilesClient;

  /** SQL Warehouses — `@databricks/sdk-warehouses`. */
  readonly warehouses: WarehousesClient;

  /** Vector Search — `@databricks/sdk-vectorsearch`. */
  readonly vectorSearch: VectorSearchClient;

  /**
   * Genie / dashboards. Delegated to the legacy SDK because the modular
   * `@databricks/sdk-genie` surface diverges (method renames + waiter
   * idiom). TODO(prod): rewrite `connectors/genie/client.ts` against the
   * modular client.
   */
  readonly genie: LegacyWorkspaceClient["genie"];

  /**
   * Jobs. Delegated to the legacy SDK because the modular
   * `@databricks/sdk-jobs` surface diverges (method renames + camelCase
   * field shapes). TODO(prod): rewrite `connectors/jobs/client.ts`.
   */
  readonly jobs: LegacyWorkspaceClient["jobs"];

  /** Statement Execution. TODO(prod): no modular package yet. */
  readonly statementExecution: LegacyWorkspaceClient["statementExecution"];

  /** Serving Endpoints. TODO(prod): no modular package yet. */
  readonly servingEndpoints: LegacyWorkspaceClient["servingEndpoints"];

  /** Current user. TODO(prod): migrate to modular IAM package when available. */
  readonly currentUser: LegacyWorkspaceClient["currentUser"];

  /**
   * Legacy config (host + authenticate) for the files-upload workaround.
   * TODO(prod): audit whether modular FilesClient.uploadFile fixes the
   * upstream upload bugs and drop this property.
   */
  readonly config: LegacyConfig;

  /**
   * Low-level authenticated HTTP. Replaces the old SDK's
   * `apiClient.request(...)` for SCIM Me header probe, serving SSE
   * streaming, and internal telemetry. Native `AbortSignal`.
   */
  readonly http: AppKitHttpClient;

  /**
   * Returns the underlying `@databricks/sdk-experimental` `WorkspaceClient`
   * for handoff to `@databricks/lakebase` (still typed against the old
   * SDK). Transitional; removed when lakebase migrates.
   */
  toLegacyWorkspaceClient(): LegacyWorkspaceClient;
}
