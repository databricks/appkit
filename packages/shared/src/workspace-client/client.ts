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
  buildGenieClient,
  type GenieClient,
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

  constructor(opts: WorkspaceClientOptions) {
    this.#opts = opts;
  }

  get files() {
    return this.#getLegacy().files;
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

  get jobs() {
    return this.#getLegacy().jobs;
  }

  // Migrated to the modular SDK — built lazily, independent of the legacy client.
  get statementExecution(): StatementExecutionClient {
    if (!this.#statementExecution) {
      this.#statementExecution = buildStatementExecutionClient(this.#opts);
    }
    return this.#statementExecution;
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
