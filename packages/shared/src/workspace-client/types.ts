/**
 * The wrapper facade type and the SDK type-namespace re-exports used across
 * AppKit.
 *
 * Every service accessor is currently typed against the legacy SDK and
 * delegated through `toLegacyWorkspaceClient()` — this PR introduces the seam
 * only, it does not migrate any service to the modular SDK. Migrating a service
 * later means changing that accessor's type here + its getter in `client.ts`
 * and updating the one connector that consumes it.
 *
 * Type-namespace re-exports (`files`, `jobs`, `serving`, `sql`) point at
 * `@databricks/sdk-experimental` so existing AppKit call-site shapes stay
 * stable. They move to the modular `@databricks/sdk-<service>` model exports
 * as each service migrates.
 */
import type { LegacyWorkspaceClient } from "./legacy";
import type { StatementExecutionClient, WarehousesClient } from "./modular";

// Legacy SDK type namespaces for un-migrated services, re-exported so AppKit
// modules import them from the wrapper rather than the SDK directly. `sql`
// stays only for the dev-mode warehouse listing in service-context, which reads
// the raw (snake_case) `/api/2.0/sql/warehouses` body via the still-legacy
// `apiClient` and types it as `sql.EndpointInfo[]`. Statement + warehouse
// service types now come from `./modular`.
export type { files, jobs, serving, sql } from "@databricks/sdk-experimental";
// Modular SDK client + model types (warehouses, statementExecution).
export type * from "./modular";

/**
 * AppKit's workspace client facade. Mirrors the multi-client shape of the
 * modular Databricks SDK: each service is its own accessor, so services can be
 * migrated one at a time behind this stable interface.
 *
 * Accessors are legacy-typed for now (delegated to the underlying legacy SDK
 * client); see the module docblock.
 */
export interface WorkspaceClient {
  /** UC Volumes / Files API. */
  readonly files: LegacyWorkspaceClient["files"];

  /** SQL Warehouses (modular SDK). */
  readonly warehouses: WarehousesClient;

  /** Genie / dashboards. */
  readonly genie: LegacyWorkspaceClient["genie"];

  /** Jobs. */
  readonly jobs: LegacyWorkspaceClient["jobs"];

  /** Statement Execution (modular SDK). */
  readonly statementExecution: StatementExecutionClient;

  /** Serving Endpoints. */
  readonly servingEndpoints: LegacyWorkspaceClient["servingEndpoints"];

  /** Current user. */
  readonly currentUser: LegacyWorkspaceClient["currentUser"];

  /**
   * SDK `Config` — exposes `host` and `authenticate(headers)`. Used by the
   * files-upload path and agents auth-header stamping, which bypass the typed
   * services.
   */
  readonly config: LegacyWorkspaceClient["config"];

  /**
   * Low-level HTTP transport (`apiClient.request(...)`). Used for endpoints
   * without a typed service method: SCIM header probe, warehouse listing,
   * serving SSE streaming, vector search, internal telemetry.
   */
  readonly apiClient: LegacyWorkspaceClient["apiClient"];

  /**
   * Returns the underlying legacy `@databricks/sdk-experimental`
   * `WorkspaceClient`, for handoff to code still typed against the old SDK
   * (`@databricks/lakebase`). Transitional.
   */
  toLegacyWorkspaceClient(): LegacyWorkspaceClient;
}
