/**
 * `AppKitWorkspaceClient` — facade over the modular Databricks SDK.
 *
 * Service properties (`files`, `warehouses`, `vectorSearch`, `genie`,
 * `jobs`) are real modular SDK service clients, constructed lazily from
 * the shared credentials + host on first access. Services that don't yet
 * have a modular package (`statementExecution`, `servingEndpoints`,
 * `currentUser`) fall back to `.toLegacyWorkspaceClient()` with a
 * `TODO(prod)` to migrate when upstream ships them.
 *
 * The wrapper also exposes:
 *   - `http`: raw `apiClient.request`-shaped HTTP, composing
 *     `@databricks/sdk-core/http` + `@databricks/sdk-auth`. Used for SCIM
 *     header probes, serving SSE streaming, internal telemetry.
 *   - `config`: legacy `Config` instance (host + authenticate) for the
 *     files-upload workaround in `connectors/files/client.ts`.
 *   - `toLegacyWorkspaceClient()`: bridge for `@databricks/lakebase`
 *     (transitional).
 */
import {
  type Credentials,
  newTokenCredentials,
  tokenProviderFn,
} from "@databricks/sdk-auth";
import { defaultCredentials } from "@databricks/sdk-auth/credentials";
import { type HttpClient, newFetchHttpClient } from "@databricks/sdk-core/http";
import { FilesClient } from "@databricks/sdk-files/v2";
import { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
import { WarehousesClient } from "@databricks/sdk-warehouses/v1";

import { AppKitHttpClient } from "./http";
import {
  buildLegacyWorkspaceClient,
  type LegacyWorkspaceClient,
  type WorkspaceClientOptions,
} from "./legacy";
import type { WorkspaceClient } from "./types";

/**
 * Concrete implementation of the wrapper interface. Construct via
 * `createWorkspaceClient(...)`; this class is internal.
 */
export class AppKitWorkspaceClient implements WorkspaceClient {
  readonly #opts: WorkspaceClientOptions;
  #legacy?: LegacyWorkspaceClient;
  #credentials?: Credentials;
  #httpClient?: HttpClient;
  #host?: string;
  #files?: FilesClient;
  #warehouses?: WarehousesClient;
  #vectorSearch?: VectorSearchClient;
  #http?: AppKitHttpClient;

  constructor(opts: WorkspaceClientOptions) {
    this.#opts = opts;
  }

  // ── Modular SDK service clients ──────────────────────────────────

  get files(): FilesClient {
    if (!this.#files) {
      this.#files = new FilesClient(this.#sharedClientOptions());
    }
    return this.#files;
  }

  get warehouses(): WarehousesClient {
    if (!this.#warehouses) {
      this.#warehouses = new WarehousesClient(this.#sharedClientOptions());
    }
    return this.#warehouses;
  }

  get vectorSearch(): VectorSearchClient {
    if (!this.#vectorSearch) {
      this.#vectorSearch = new VectorSearchClient(this.#sharedClientOptions());
    }
    return this.#vectorSearch;
  }

  // ── Services delegated to legacy ─────────────────────────────────
  //
  // `genie` and `jobs` modular packages exist (`@databricks/sdk-genie`,
  // `@databricks/sdk-jobs`) but their client surfaces diverge from the
  // legacy SDK enough that the connectors need a rewrite — method names
  // changed (`createMessage` → `genieCreateConversationMessageWaiter`,
  // `submit` → `submitRunWaiter`, etc.) and request/response shapes
  // moved snake_case → camelCase. TODO(prod): rewrite
  // `connectors/genie/client.ts` and `connectors/jobs/client.ts` against
  // the modular surface, then swap these getters to:
  //   new GenieClient(this.#sharedClientOptions())
  //   new JobsClient(this.#sharedClientOptions())

  get genie() {
    return this.#getLegacy().genie;
  }

  get jobs() {
    return this.#getLegacy().jobs;
  }

  // ── Services without a modular package yet ───────────────────────
  //
  // TODO(prod): swap to modular packages once published. Each becomes its
  // own `new <Service>Client(this.#sharedClientOptions())` lazy getter.

  get statementExecution() {
    return this.#getLegacy().statementExecution;
  }

  get servingEndpoints() {
    return this.#getLegacy().servingEndpoints;
  }

  get currentUser() {
    return this.#getLegacy().currentUser;
  }

  /**
   * Legacy `Config` — exposes `host` and `authenticate(headers)`. Used
   * directly by the files-upload workaround in
   * `connectors/files/client.ts` which bypasses the SDK to fix two
   * upstream upload bugs in `@databricks/sdk-experimental`.
   * TODO(prod): audit whether `FilesClient.uploadFile` fixes those bugs;
   * drop this property if so.
   */
  get config() {
    return this.#getLegacy().config;
  }

  get http(): AppKitHttpClient {
    if (!this.#http) {
      this.#http = new AppKitHttpClient({
        host: () => this.#resolveHost(),
        credentials: () => this.#getCredentials(),
        httpClient: this.#getHttpClient(),
      });
    }
    return this.#http;
  }

  toLegacyWorkspaceClient(): LegacyWorkspaceClient {
    return this.#getLegacy();
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Options object handed to every modular service client. We deliberately
   * do NOT pass `httpClient` here: the modular SDK's `newHttpClient` throws
   * "httpClient cannot be combined with credentials or timeout" when both
   * are present (it treats `httpClient` as a pre-wired transport that has
   * auth baked in). For the wrapper we want shared credentials with a
   * per-service internal transport, which is what `{ host, credentials }`
   * alone gives us.
   *
   * TODO(prod): if pool sharing across services becomes important, build
   * a single pre-authenticated HttpClient and pass it via `httpClient`
   * only (no `credentials`), per the modular SDK contract.
   */
  #sharedClientOptions() {
    return {
      host: this.#resolveHost(),
      credentials: this.#getCredentials(),
    };
  }

  #getLegacy(): LegacyWorkspaceClient {
    if (!this.#legacy) {
      this.#legacy = buildLegacyWorkspaceClient(this.#opts);
    }
    return this.#legacy;
  }

  #getCredentials(): Credentials {
    if (this.#credentials) return this.#credentials;
    const token = this.#opts.token;
    if (token !== undefined) {
      // PAT-style bearer token. Wrap in a token provider so the modular
      // SDK's credential interface gets a "Bearer <token>" header.
      this.#credentials = newTokenCredentials(
        "pat",
        tokenProviderFn(async () => ({ value: token })),
      );
    } else {
      // Walks the SDK default chain: env vars → ~/.databrickscfg → CLI.
      this.#credentials = defaultCredentials();
    }
    return this.#credentials;
  }

  #getHttpClient(): HttpClient {
    if (!this.#httpClient) {
      this.#httpClient = newFetchHttpClient();
    }
    return this.#httpClient;
  }

  #resolveHost(): string {
    if (this.#host) return this.#host;
    const host = this.#opts.host ?? process.env.DATABRICKS_HOST;
    if (host) {
      this.#host = host.startsWith("http") ? host : `https://${host}`;
      return this.#host;
    }
    // Lazy fallback: if no explicit host was passed, the legacy client
    // resolves it from ~/.databrickscfg / DATABRICKS_CONFIG_PROFILE / etc.
    // We piggy-back on that resolution rather than reimplementing the
    // profile-loading chain at PoC quality.
    const legacyHost = this.#getLegacy().config.host;
    if (!legacyHost) {
      throw new Error(
        "Databricks host is not configured. Set DATABRICKS_HOST or pass `host` to createWorkspaceClient.",
      );
    }
    this.#host = legacyHost.startsWith("http")
      ? legacyHost
      : `https://${legacyHost}`;
    return this.#host;
  }
}
