/**
 * `AppKitWorkspaceClient` — the facade implementation. Construct via
 * `createWorkspaceClient(...)`; this class is internal.
 *
 * Every service accessor delegates to a single lazily-constructed legacy SDK
 * client. This is the seam: to migrate a service to the modular SDK, replace
 * its getter here with a modular client instance (and update its connector +
 * the accessor type in `types.ts`). No other AppKit module touches the SDK.
 */
import {
  buildLegacyWorkspaceClient,
  type LegacyWorkspaceClient,
  type WorkspaceClientOptions,
} from "./legacy";
import {
  buildScimClient,
  buildStatementExecutionClient,
  buildWarehousesClient,
  buildWorkspaceAuth,
  type ScimClient,
  buildFunctionsClient,
  buildGenieClient,
  type FunctionsClient,
  type GenieClient,
  buildJobsClient,
  type JobsClient,
  buildModelServingClient,
  type ModelServingClient,
  buildFilesClient,
  type FilesClient,
  buildConnectionsClient,
  type ConnectionsClient,
  buildTablesClient,
  type TablesClient,
  buildVolumesClient,
  type VolumesClient,
  buildVectorSearchClient,
  type VectorSearchClient,
  type StatementExecutionClient,
  type WarehousesClient,
  type WorkspaceAuth,
  type WorkspaceRequest,
} from "./modular";
import type { WorkspaceClient } from "./types";

export class AppKitWorkspaceClient implements WorkspaceClient {
  readonly #opts: WorkspaceClientOptions;
  #legacy?: LegacyWorkspaceClient;
  #warehouses?: WarehousesClient;
  #statementExecution?: StatementExecutionClient;
  #auth?: WorkspaceAuth;
  #currentUser?: ScimClient;
  #genie?: GenieClient;
  #jobs?: JobsClient;
  #modelServing?: ModelServingClient;
  #files?: FilesClient;
  #vectorSearch?: VectorSearchClient;
  #tables?: TablesClient;
  #volumes?: VolumesClient;
  #functions?: FunctionsClient;
  #connections?: ConnectionsClient;

  constructor(opts: WorkspaceClientOptions) {
    this.#opts = opts;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get files(): FilesClient {
    if (!this.#files) {
      this.#files = buildFilesClient(this.#opts);
    }
    return this.#files;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get warehouses(): WarehousesClient {
    if (!this.#warehouses) {
      this.#warehouses = buildWarehousesClient(this.#opts);
    }
    return this.#warehouses;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get genie(): GenieClient {
    if (!this.#genie) {
      this.#genie = buildGenieClient(this.#opts);
    }
    return this.#genie;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get jobs(): JobsClient {
    if (!this.#jobs) {
      this.#jobs = buildJobsClient(this.#opts);
    }
    return this.#jobs;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get vectorSearch(): VectorSearchClient {
    if (!this.#vectorSearch) {
      this.#vectorSearch = buildVectorSearchClient(this.#opts);
    }
    return this.#vectorSearch;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get tables(): TablesClient {
    if (!this.#tables) {
      this.#tables = buildTablesClient(this.#opts);
    }
    return this.#tables;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get connections(): ConnectionsClient {
    if (!this.#connections) {
      this.#connections = buildConnectionsClient(this.#opts);
    }
    return this.#connections;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get functions(): FunctionsClient {
    if (!this.#functions) {
      this.#functions = buildFunctionsClient(this.#opts);
    }
    return this.#functions;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get volumes(): VolumesClient {
    if (!this.#volumes) {
      this.#volumes = buildVolumesClient(this.#opts);
    }
    return this.#volumes;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get statementExecution(): StatementExecutionClient {
    if (!this.#statementExecution) {
      this.#statementExecution = buildStatementExecutionClient(this.#opts);
    }
    return this.#statementExecution;
  }

  // Modular serving endpoints client. A new accessor because `servingEndpoints`
  // is the legacy client's public type and can't change.
  get modelServing(): ModelServingClient {
    if (!this.#modelServing) {
      this.#modelServing = buildModelServingClient(this.#opts);
    }
    return this.#modelServing;
  }

  get servingEndpoints() {
    return this.#getLegacy().servingEndpoints;
  }

  // Migrated to the modular SDK (SCIM) — built lazily, independent of the legacy client.
  get currentUser(): ScimClient {
    if (!this.#currentUser) {
      this.#currentUser = buildScimClient(this.#opts);
    }
    return this.#currentUser;
  }

  // Modular auth + raw-request seam — built lazily, independent of the legacy client.
  getHost(): Promise<string> {
    return this.#getAuth().getHost();
  }

  authenticate(headers: Headers): Promise<void> {
    return this.#getAuth().authenticate(headers);
  }

  request(req: WorkspaceRequest): Promise<Response> {
    return this.#getAuth().request(req);
  }

  get config() {
    return this.#getLegacy().config;
  }

  get apiClient() {
    return this.#getLegacy().apiClient;
  }

  toLegacyWorkspaceClient(): LegacyWorkspaceClient {
    return this.#getLegacy();
  }

  #getAuth(): WorkspaceAuth {
    if (!this.#auth) {
      this.#auth = buildWorkspaceAuth(this.#opts);
    }
    return this.#auth;
  }

  #getLegacy(): LegacyWorkspaceClient {
    if (!this.#legacy) {
      this.#legacy = buildLegacyWorkspaceClient(this.#opts);
    }
    return this.#legacy;
  }
}
