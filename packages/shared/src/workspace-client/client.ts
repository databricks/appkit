/**
 * `AppKitWorkspaceClient` — the facade implementation. Construct via
 * `createWorkspaceClient(...)`; this class is internal.
 *
 * Every service accessor builds its modular `@databricks/sdk-*` client lazily
 * (see `modular.ts`); raw REST calls go through the auth + request seam. No
 * other AppKit module touches the SDK.
 */
import {
  buildScimClient,
  buildStatementExecutionClient,
  buildWarehousesClient,
  buildWorkspaceAuth,
  type ScimClient,
  buildFunctionsClient,
  buildDatabaseClient,
  type DatabaseClient,
  buildGenieClient,
  type FunctionsClient,
  type GenieClient,
  buildAppsClient,
  type AppsClient,
  buildJobsClient,
  buildExperimentsClient,
  type ExperimentsClient,
  type JobsClient,
  buildModelServingClient,
  type ModelServingClient,
  buildFilesClient,
  type FilesClient,
  buildConnectionsClient,
  type ConnectionsClient,
  buildTablesClient,
  type TablesClient,
  buildPostgresClient,
  type PostgresClient,
  buildVolumesClient,
  type VolumesClient,
  buildVectorSearchClient,
  type VectorSearchClient,
  type StatementExecutionClient,
  type WarehousesClient,
  type WorkspaceAuth,
  type WorkspaceRequest,
} from "./modular";
import type { WorkspaceClientOptions } from "./options";
import type { WorkspaceClient } from "./types";

export class AppKitWorkspaceClient implements WorkspaceClient {
  readonly #opts: WorkspaceClientOptions;
  #warehouses?: WarehousesClient;
  #statementExecution?: StatementExecutionClient;
  #auth?: WorkspaceAuth;
  #currentUser?: ScimClient;
  #genie?: GenieClient;
  #database?: DatabaseClient;
  #apps?: AppsClient;
  #jobs?: JobsClient;
  #modelServing?: ModelServingClient;
  #experiments?: ExperimentsClient;
  #files?: FilesClient;
  #vectorSearch?: VectorSearchClient;
  #tables?: TablesClient;
  #postgres?: PostgresClient;
  #volumes?: VolumesClient;
  #functions?: FunctionsClient;
  #connections?: ConnectionsClient;

  constructor(opts: WorkspaceClientOptions) {
    this.#opts = opts;
  }

  // Migrated to the modular SDK — built lazily.
  get files(): FilesClient {
    if (!this.#files) {
      this.#files = buildFilesClient(this.#opts);
    }
    return this.#files;
  }

  // Migrated to the modular SDK — built lazily.
  get warehouses(): WarehousesClient {
    if (!this.#warehouses) {
      this.#warehouses = buildWarehousesClient(this.#opts);
    }
    return this.#warehouses;
  }

  // Migrated to the modular SDK — built lazily.
  get genie(): GenieClient {
    if (!this.#genie) {
      this.#genie = buildGenieClient(this.#opts);
    }
    return this.#genie;
  }

  // Migrated to the modular SDK — built lazily.
  get apps(): AppsClient {
    if (!this.#apps) {
      this.#apps = buildAppsClient(this.#opts);
    }
    return this.#apps;
  }

  // Migrated to the modular SDK — built lazily.
  get database(): DatabaseClient {
    if (!this.#database) {
      this.#database = buildDatabaseClient(this.#opts);
    }
    return this.#database;
  }

  // Migrated to the modular SDK — built lazily.
  get jobs(): JobsClient {
    if (!this.#jobs) {
      this.#jobs = buildJobsClient(this.#opts);
    }
    return this.#jobs;
  }

  // Migrated to the modular SDK — built lazily.
  get experiments(): ExperimentsClient {
    if (!this.#experiments) {
      this.#experiments = buildExperimentsClient(this.#opts);
    }
    return this.#experiments;
  }

  // Migrated to the modular SDK — built lazily.
  get vectorSearch(): VectorSearchClient {
    if (!this.#vectorSearch) {
      this.#vectorSearch = buildVectorSearchClient(this.#opts);
    }
    return this.#vectorSearch;
  }

  // Migrated to the modular SDK — built lazily.
  get tables(): TablesClient {
    if (!this.#tables) {
      this.#tables = buildTablesClient(this.#opts);
    }
    return this.#tables;
  }

  // Migrated to the modular SDK — built lazily.
  get postgres(): PostgresClient {
    if (!this.#postgres) {
      this.#postgres = buildPostgresClient(this.#opts);
    }
    return this.#postgres;
  }

  // Migrated to the modular SDK — built lazily.
  get connections(): ConnectionsClient {
    if (!this.#connections) {
      this.#connections = buildConnectionsClient(this.#opts);
    }
    return this.#connections;
  }

  // Migrated to the modular SDK — built lazily.
  get functions(): FunctionsClient {
    if (!this.#functions) {
      this.#functions = buildFunctionsClient(this.#opts);
    }
    return this.#functions;
  }

  // Migrated to the modular SDK — built lazily.
  get volumes(): VolumesClient {
    if (!this.#volumes) {
      this.#volumes = buildVolumesClient(this.#opts);
    }
    return this.#volumes;
  }

  // Migrated to the modular SDK — built lazily.
  get statementExecution(): StatementExecutionClient {
    if (!this.#statementExecution) {
      this.#statementExecution = buildStatementExecutionClient(this.#opts);
    }
    return this.#statementExecution;
  }

  get modelServing(): ModelServingClient {
    if (!this.#modelServing) {
      this.#modelServing = buildModelServingClient(this.#opts);
    }
    return this.#modelServing;
  }

  // Migrated to the modular SDK (SCIM) — built lazily.
  get currentUser(): ScimClient {
    if (!this.#currentUser) {
      this.#currentUser = buildScimClient(this.#opts);
    }
    return this.#currentUser;
  }

  // Modular auth + raw-request seam — built lazily.
  getHost(): Promise<string> {
    return this.#getAuth().getHost();
  }

  authenticate(headers: Headers): Promise<void> {
    return this.#getAuth().authenticate(headers);
  }

  request(req: WorkspaceRequest): Promise<Response> {
    return this.#getAuth().request(req);
  }

  #getAuth(): WorkspaceAuth {
    if (!this.#auth) {
      this.#auth = buildWorkspaceAuth(this.#opts);
    }
    return this.#auth;
  }
}
