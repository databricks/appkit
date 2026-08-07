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
import type { WorkspaceClient } from "./types";

export class AppKitWorkspaceClient implements WorkspaceClient {
  readonly #opts: WorkspaceClientOptions;
  #legacy?: LegacyWorkspaceClient;

  constructor(opts: WorkspaceClientOptions) {
    this.#opts = opts;
  }

  get files() {
    return this.#getLegacy().files;
  }

  get warehouses() {
    return this.#getLegacy().warehouses;
  }

  get genie() {
    return this.#getLegacy().genie;
  }

  get jobs() {
    return this.#getLegacy().jobs;
  }

  get statementExecution() {
    return this.#getLegacy().statementExecution;
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
