/**
 * The wrapper facade type and the SDK type-namespace re-exports used across
 * AppKit.
 *
 * Accessors for migrated services are typed against their modular
 * `@databricks/sdk-*` clients (built in `modular.ts`); the rest are still the
 * legacy SDK's, delegated through `toLegacyWorkspaceClient()`. Migrating a
 * service means changing its accessor's type here, its getter in `client.ts`,
 * and the connector that consumes it.
 *
 * Type-namespace re-exports (`serving`, `sql`) point at
 * `@databricks/sdk-experimental` so existing AppKit call-site shapes stay
 * stable. They move to the modular `@databricks/sdk-<service>` model exports
 * as each service migrates.
 */
import type { LegacyWorkspaceClient } from "./legacy";
import type {
  StatementExecutionClient,
  WarehousesClient,
  WorkspaceAuth,
  ScimClient,
  GenieClient,
  JobsClient,
  ModelServingClient,
  FilesClient,
  TablesClient,
  VectorSearchClient,
  PostgresClient,
} from "./modular";

// Legacy SDK type namespaces for un-migrated services, re-exported so AppKit
// modules import them from the wrapper rather than the SDK directly. `sql`
// stays only for the dev-mode warehouse discovery in appkit's
// `resources/warehouse.ts`, which reads the raw (snake_case)
// `/api/2.0/sql/warehouses` body via the still-legacy `apiClient` and types it
// as `sql.EndpointInfo[]`. It is not on the modular `listWarehouses` because
// that request has no `skip_cannot_use` filter, so it could pick a warehouse
// the caller can't use. Statement + warehouse service types come from `./modular`.
export type { serving, sql } from "@databricks/sdk-experimental";
// Modular SDK client + model types (warehouses, statementExecution, genie, jobs, files).
export type * from "./modular";

/**
 * AppKit's workspace client facade. Mirrors the multi-client shape of the
 * modular Databricks SDK: each service is its own accessor, so services can be
 * migrated one at a time behind this stable interface.
 *
 * Accessors are legacy-typed for now (delegated to the underlying legacy SDK
 * client); see the module docblock.
 */
export interface WorkspaceClient extends WorkspaceAuth {
  /** UC Volumes / Files API (modular SDK). */
  readonly files: FilesClient;

  /** SQL Warehouses (modular SDK). */
  readonly warehouses: WarehousesClient;

  /** Genie (modular SDK). */
  readonly genie: GenieClient;

  /** Jobs (modular SDK, Jobs API 2.2). */
  readonly jobs: JobsClient;

  /** Vector Search (modular SDK; index metadata only, queries use `request()`). */
  readonly vectorSearch: VectorSearchClient;

  /** Unity Catalog Tables (modular SDK). */
  readonly tables: TablesClient;
  /** Lakebase Postgres: autoscaling projects, branches, endpoints (modular SDK). */
  readonly postgres: PostgresClient;

  /** Statement Execution (modular SDK). */
  readonly statementExecution: StatementExecutionClient;

  /** Serving endpoints (modular SDK). `servingEndpoints` below stays legacy-typed. */
  readonly modelServing: ModelServingClient;

  /** Serving Endpoints. */
  readonly servingEndpoints: LegacyWorkspaceClient["servingEndpoints"];

  /** Current user (modular SDK SCIM client; `me({})` returns the caller). */
  readonly currentUser: ScimClient;

  /**
   * Legacy SDK `Config`. Prefer `getHost()` / `authenticate(headers)` (modular,
   * inherited from `WorkspaceAuth`); kept for structural `WorkspaceClientLike`
   * callers (supervisor adapter) and the files upload (moves to the modular
   * `files.uploadFile` with the files migration) until they migrate.
   */
  readonly config: LegacyWorkspaceClient["config"];

  /**
   * Legacy low-level HTTP transport. Prefer `request(...)` (modular, inherited
   * from `WorkspaceAuth`); still used by serving SSE streaming, vector search,
   * the files upload User-Agent, and the agents adapters, which take a
   * structural `apiClient` shape.
   */
  readonly apiClient: LegacyWorkspaceClient["apiClient"];

  /**
   * Returns the underlying legacy `@databricks/sdk-experimental`
   * `WorkspaceClient`, for handoff to code still typed against the old SDK
   * (`@databricks/lakebase`). Transitional.
   */
  toLegacyWorkspaceClient(): LegacyWorkspaceClient;
}
