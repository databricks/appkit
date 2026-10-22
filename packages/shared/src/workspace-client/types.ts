/**
 * The wrapper facade type and the modular SDK type re-exports used across
 * AppKit. Every service accessor is a modular `@databricks/sdk-*` client
 * (built in `modular.ts`); raw REST calls use the inherited `request()` seam.
 */
import type {
  StatementExecutionClient,
  WarehousesClient,
  WorkspaceAuth,
  ScimClient,
  AppsClient,
  GenieClient,
  DatabaseClient,
  JobsClient,
  ModelServingClient,
  ExperimentsClient,
  FilesClient,
  TablesClient,
  VolumesClient,
  FunctionsClient,
  ConnectionsClient,
  VectorSearchClient,
  PostgresClient,
} from "./modular";

// Modular SDK client + model types (warehouses, statementExecution, genie, jobs, files).
export type * from "./modular";

/**
 * AppKit's workspace client facade. Mirrors the multi-client shape of the
 * modular Databricks SDK: each service is its own accessor, so services can be
 * migrated one at a time behind this stable interface.
 *
 */
export interface WorkspaceClient extends WorkspaceAuth {
  /** UC Volumes / Files API (modular SDK). */
  readonly files: FilesClient;

  /** SQL Warehouses (modular SDK). */
  readonly warehouses: WarehousesClient;

  /** Genie (modular SDK). */
  readonly genie: GenieClient;

  /** Lakebase provisioned database instances + credentials (modular SDK). */
  readonly database: DatabaseClient;

  /** Databricks Apps (modular SDK). */
  readonly apps: AppsClient;

  /** Jobs (modular SDK, Jobs API 2.2). */
  readonly jobs: JobsClient;

  /** MLflow Experiments (modular SDK). */
  readonly experiments: ExperimentsClient;

  /** Vector Search (modular SDK; index metadata only, queries use `request()`). */
  readonly vectorSearch: VectorSearchClient;

  /** Unity Catalog Tables (modular SDK). */
  readonly tables: TablesClient;
  /** Lakebase Postgres: autoscaling projects, branches, endpoints (modular SDK). */
  readonly postgres: PostgresClient;

  /** Unity Catalog Volumes (modular SDK). */
  readonly volumes: VolumesClient;

  /** Unity Catalog Functions (modular SDK). */
  readonly functions: FunctionsClient;

  /** Unity Catalog Connections (modular SDK). */
  readonly connections: ConnectionsClient;

  /** Statement Execution (modular SDK). */
  readonly statementExecution: StatementExecutionClient;

  /** Serving endpoints (modular SDK). */
  readonly modelServing: ModelServingClient;

  /** Current user (modular SDK SCIM client; `me({})` returns the caller). */
  readonly currentUser: ScimClient;
}
