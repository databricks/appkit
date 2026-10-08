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
  buildStatementExecutionClient,
  buildWarehousesClient,
  type StatementExecutionClient,
  type WarehousesClient,
} from "./modular";
import type { WorkspaceClient } from "./types";

export class AppKitWorkspaceClient implements WorkspaceClient {
  readonly #opts: WorkspaceClientOptions;
  #legacy?: LegacyWorkspaceClient;
  #warehouses?: WarehousesClient;
  #statementExecution?: StatementExecutionClient;

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

  get genie() {
    return this.#getLegacy().genie;
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

  get currentUser() {
    return this.#getLegacy().currentUser;
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

  #getLegacy(): LegacyWorkspaceClient {
    if (!this.#legacy) {
      this.#legacy = buildLegacyWorkspaceClient(this.#opts);
    }
    return this.#legacy;
  }
}
