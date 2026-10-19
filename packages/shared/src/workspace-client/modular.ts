/**
 * The single module allowed to import the modular `@databricks/sdk-*` SDK
 * directly — the new-SDK sibling of {@link ./legacy.ts}. Every other AppKit
 * module reaches these clients through the {@link WorkspaceClient} facade and
 * the type re-exports below, so the modular SDK stays isolated exactly like the
 * legacy one (the oxlint `no-restricted-imports` boundary walls `@databricks/sdk-*`
 * off everywhere outside `packages/shared/src/workspace-client/`).
 *
 * Migrated services are built here as per-service clients; the facade delegates
 * their accessors to these instead of the legacy monolithic client. Currently
 * `warehouses`, `statementExecution`, `currentUser` (SCIM), `genie`, `jobs`,
 * `files`, `vectorSearch`, `tables`, `modelServing`, `volumes`, `functions`,
 * `connections`, `database`, `postgres`, `experiments` and `apps` are
 * migrated, plus the auth + raw-request seam ({@link buildWorkspaceAuth}).
 * Only `servingEndpoints`, `config` and `apiClient` still route through
 * `legacy.ts`.
 *
 * NOTE: statementExecution relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-statementexecution@0.52.0.patch`) that restores the
 * undocumented Reyden `attachment` response field, which the SDK's generated
 * unmarshal transform would otherwise strip.
 *
 * NOTE: vectorSearch relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-vectorsearch@0.51.0.patch`): it adds the
 * undocumented query `debug_level` request / `debug_info` response fields (the
 * source of ai-search `queryTimeMs`), and lets row values be `bigint`, since the
 * SDK parses with json-bigint and the unpatched schema rejects ints over 2^53.
 *
 * NOTE: genie relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-genie@0.54.0.patch`): the generated model types the
 * query result's `data_array` as protobuf `ListValue[]` (`{ values: [...] }`), but
 * the API returns plain `JSON_ARRAY` rows (`[["a", null], ...]`), so the unmarshal
 * schema rejected every real query result. The patch restores `(string | null)[][]`.
 */
import { execFile } from "node:child_process";
import { STATUS_CODES } from "node:http";
import { promisify } from "node:util";

import type { AppsClient } from "@databricks/sdk-apps/v1";
import {
  type Credentials,
  newTokenCredentials,
  type Token,
  type TokenCredentials,
  tokenProviderFn,
} from "@databricks/sdk-auth";
import {
  DefaultCredentialsError,
  defaultCredentials,
  M2mCredentialsError,
  newM2mCredentials,
  newPatCredentials,
  newU2mCredentials,
  PatCredentialsError,
  U2mCredentialsError,
} from "@databricks/sdk-auth/credentials";
import {
  type HttpClient,
  type HttpRequest,
  newFetchHttpClient,
} from "@databricks/sdk-core/http";
import { type ProfileOptions, resolve } from "@databricks/sdk-core/profiles";
import type { DatabaseClient } from "@databricks/sdk-database/v1";
import type { ExperimentsClient } from "@databricks/sdk-experiments/v1";
import type { FilesClient } from "@databricks/sdk-files/v2";
import type { GenieClient } from "@databricks/sdk-genie/v1";
import type { JobsClient } from "@databricks/sdk-jobs/v2";
import type { ModelServingClient } from "@databricks/sdk-modelserving/v1";
import type { ClientOptions } from "@databricks/sdk-options/client";
import type { PostgresClient } from "@databricks/sdk-postgres/v1";
import { ScimClient } from "@databricks/sdk-scim/v1";
import { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
import type { ConnectionsClient } from "@databricks/sdk-uc-connections/v1";
import type { FunctionsClient } from "@databricks/sdk-uc-functions/v1";
import type { TablesClient } from "@databricks/sdk-uc-tables/v1";
import type { VolumesClient } from "@databricks/sdk-uc-volumes/v1";
import type { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
import { WarehousesClient } from "@databricks/sdk-warehouses/v1";

import { ApiError } from "./errors";
import type { WorkspaceClientOptions } from "./options";

/**
 * Prepend `https://` to a scheme-less host. The legacy SDK normalized the host
 * this way; the modular SDK does NOT — it passes the host straight into `fetch`,
 * so a bare `DATABRICKS_HOST=my-workspace.cloud.databricks.com` (the common form,
 * and what the Databricks Apps runtime sets) yields `TypeError: Invalid URL`.
 */
function normalizeHost(host: string | undefined): string | undefined {
  const trimmed = host?.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Same margin as the legacy SDK: refresh 40s early, since Azure Databricks
// rejects tokens that expire in 30s or less.
const TOKEN_REFRESH_MARGIN_MS = 40_000;

/**
 * Cache a token until shortly before it expires. The modular `newM2mCredentials`
 * caches only the token endpoint and mints a fresh OAuth token on EVERY request;
 * the legacy SDK reused it until expiry. Concurrent callers share one in-flight
 * fetch. Like the legacy SDK, a token without an expiry is reused indefinitely.
 */
function withTokenCache(credentials: TokenCredentials): TokenCredentials {
  let current: Token | undefined;
  let inflight: Promise<Token> | undefined;
  const isFresh = (t: Token) =>
    t.expiry === undefined ||
    t.expiry.getTime() - TOKEN_REFRESH_MARGIN_MS > Date.now();
  return newTokenCredentials(
    credentials.name(),
    tokenProviderFn(async () => {
      if (current && isFresh(current)) return current;
      inflight ??= credentials
        .token()
        .then((t) => (current = t))
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    }),
  );
}

/**
 * The SDK default chain (profile / `~/.databrickscfg`), with the token cache the
 * chain lacks: its CLI strategy shells out to `databricks auth token` and its
 * M2M strategy mints a new OAuth token on EVERY request. `DefaultCredentials`
 * hides the token behind `authHeaders()`, so mirror its strategy order (PAT →
 * M2M → CLI) to get a cacheable `TokenCredentials`. A profile `authType` naming
 * one of these (`databricks auth login` writes `databricks-cli`) pins that
 * strategy; other auth types and `groupId` keep the SDK's own (uncached) logic.
 * TODO: drop once sdk-auth caches tokens in its M2M and CLI credentials.
 */
function cachedDefaultCredentials(
  profileOptions?: ProfileOptions,
): Credentials {
  const select = async (): Promise<Credentials> => {
    const profile = await resolve(profileOptions);
    // Same as env M2M: OAuth discovery needs a scheme, which a profile may omit.
    const host = normalizeHost(profile.host)?.replace(/\/+$/, "");
    const { name, token, clientId, clientSecret, authType } = profile;
    const allows = (strategy: string) => !authType || authType === strategy;
    if (host && !profile.groupId) {
      if (token && allows("pat")) return newPatCredentials(token.value);
      if (clientId && clientSecret && allows("oauth-m2m")) {
        return withTokenCache(
          newM2mCredentials({
            host,
            clientId,
            clientSecret: clientSecret.value,
            ...(profile.accountId !== undefined && {
              accountId: profile.accountId,
            }),
          }),
        );
      }
      if (name && allows("databricks-cli")) {
        return withTokenCache(
          newU2mCredentials({
            profile: name,
            ...(profile.databricksCliPath !== undefined && {
              cliPath: profile.databricksCliPath,
            }),
          }),
        );
      }
    }
    return defaultCredentials({
      profile: { ...profile, ...(host && { host }) },
    });
  };
  let selected: Promise<Credentials> | undefined;
  return {
    name: () => "default",
    async authHeaders() {
      selected ??= select().catch((e) => {
        selected = undefined;
        throw e;
      });
      return (await selected).authHeaders();
    },
  };
}

const execFileAsync = promisify(execFile);

/** Auth could not be configured (missing or unsupported credentials). */
export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/** Whether `e` means auth isn't set up, from AppKit or the modular SDK. */
export function isAuthConfigError(e: unknown): e is Error {
  return (
    e instanceof AuthConfigError ||
    e instanceof DefaultCredentialsError ||
    e instanceof M2mCredentialsError ||
    e instanceof PatCredentialsError ||
    e instanceof U2mCredentialsError
  );
}

/**
 * Databricks CLI auth for a host, not a profile: what the legacy SDK used when
 * only a host was configured. The modular CLI strategy needs a profile name.
 */
function cliHostCredentials(host: string): TokenCredentials {
  return withTokenCache(
    newTokenCredentials(
      "databricks-cli",
      tokenProviderFn(async () => {
        let stdout: string;
        try {
          ({ stdout } = await execFileAsync("databricks", [
            "auth",
            "token",
            "--host",
            host,
          ]));
        } catch (e) {
          const err = e as { stderr?: unknown; message?: string };
          const detail = String(err.stderr ?? err.message ?? e).trim();
          throw new AuthConfigError(
            `cannot get an access token for ${host} from the Databricks CLI: ${detail}`,
          );
        }
        const parsed = JSON.parse(stdout) as {
          access_token: string;
          expiry?: string;
        };
        return {
          value: parsed.access_token,
          ...(parsed.expiry && { expiry: new Date(parsed.expiry) }),
        };
      }),
    ),
  );
}

/** Credentials that fail on use with `message`, so boot surfaces it clearly. */
function unsupportedCredentials(message: string): Credentials {
  return {
    name: () => "unsupported",
    authHeaders: async () => {
      throw new AuthConfigError(message);
    },
  };
}

/**
 * Map wrapper options onto the modular SDK's `ClientOptions`, reproducing the
 * legacy SDK's auth resolution: explicit token → PAT (the OBO path); profile →
 * profile file; otherwise the service principal from the environment. It carries
 * the privilege-escalation guard — check `token !== undefined` (NOT truthiness)
 * so an explicitly-passed token, even an empty string, pins the PAT path and
 * fails loudly at request time rather than silently falling through to the
 * service-principal env credentials (which would be an OBO privilege escalation).
 */
function mapToClientOptions(opts: WorkspaceClientOptions): ClientOptions {
  const clientOptions: ClientOptions = {};
  // Resolve + scheme-normalize the host the way the legacy SDK did. Explicit
  // `opts.host` wins; otherwise fall back to `DATABRICKS_HOST` (env is where the
  // Apps runtime and dev set it). When a profile is selected without an explicit
  // host, defer to the SDK's profile-file resolution instead of the env.
  const host = normalizeHost(
    opts.host ?? (opts.profile ? undefined : process.env.DATABRICKS_HOST),
  );
  if (host) {
    clientOptions.host = host;
  }
  if (opts.token !== undefined) {
    // Explicit token (this is the OBO path: `asUser` passes the user's token).
    clientOptions.credentials = newPatCredentials(opts.token);
  } else if (opts.profile) {
    clientOptions.profileOptions = { profile: opts.profile };
    clientOptions.credentials = cachedDefaultCredentials({
      profile: opts.profile,
    });
  } else {
    // No token, no profile: authenticate as the service principal from the
    // environment. The SDK's own default chain DOES read the DATABRICKS_* env
    // vars (host, client id/secret, token) — but its M2M strategy feeds the RAW
    // `DATABRICKS_HOST` straight into OAuth token-endpoint discovery, and the
    // Databricks Apps runtime sets that host scheme-less (e.g.
    // `x.cloud.databricks.com`), so discovery fails with `Invalid URL` and every
    // request dies as "Warehouse readiness check failed". Resolve the SP here
    // with the scheme-normalized `host` instead: M2M from client id + secret
    // (what Apps injects), else PAT from `DATABRICKS_TOKEN`, else fall through to
    // the SDK default chain (local dev, where a `~/.databrickscfg` host already
    // carries a scheme).
    // `DATABRICKS_AUTH_TYPE`, like in the legacy SDK, pins the strategy.
    const clientId = process.env.DATABRICKS_CLIENT_ID;
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    const envToken = process.env.DATABRICKS_TOKEN;
    const authType = process.env.DATABRICKS_AUTH_TYPE?.trim() || undefined;
    const allows = (strategy: string) => !authType || authType === strategy;
    if (host && clientId && clientSecret && allows("oauth-m2m")) {
      clientOptions.credentials = withTokenCache(
        newM2mCredentials({ host, clientId, clientSecret }),
      );
    } else if (envToken && allows("pat")) {
      clientOptions.credentials = newPatCredentials(envToken);
    } else if (host && allows("databricks-cli")) {
      // A configured host means ~/.databrickscfg is NOT consulted (legacy
      // rule): a profile's credentials must never be sent to another host.
      clientOptions.credentials = cliHostCredentials(host);
    } else if (!host && !authType) {
      // Local dev with no host anywhere: the profile-based default chain.
      clientOptions.credentials = cachedDefaultCredentials();
    } else {
      clientOptions.credentials = unsupportedCredentials(
        `DATABRICKS_AUTH_TYPE=${authType ?? ""} cannot be satisfied: supported types are pat (DATABRICKS_TOKEN), oauth-m2m (DATABRICKS_CLIENT_ID/SECRET) and databricks-cli (\`databricks auth login\`).`,
      );
    }
  }
  clientOptions.httpClient = buildHttpClient(opts);
  return clientOptions;
}

/**
 * Wrap the SDK's default fetch transport to prepend AppKit's product segment to
 * the outgoing `User-Agent`, preserving the exact legacy string (e.g.
 * `@databricks/appkit/0.75.1`) that Databricks-side dashboards match on.
 *
 * Why the transport and not `setProduct`: the modular SDK's client-info API
 * validates the product as a simple token and rejects `@databricks/appkit` (the
 * `@`/`/`), and it is process-global. Setting the header on the `httpClient`
 * instead keeps the literal product name, is per-client, and — unlike a pnpm
 * patch — ships inside appkit's bundled `dist`, so it also reaches deployed apps
 * (npm-installed from the tarball, where pnpm patches do not apply). The SDK's
 * own client-info (`sdk-js-core/…`, runtime) is already on `request.headers`, so
 * prepending keeps it intact after AppKit's segment.
 *
 * Returns `undefined` when no product is configured (build-time callers), leaving
 * the SDK's default User-Agent untouched — matching the legacy behavior where
 * build-time clients carried no AppKit UA.
 */
function buildHttpClient(opts: WorkspaceClientOptions): HttpClient {
  const co = opts.clientOptions;
  let appkitUserAgent: string | undefined;
  if (co?.product && co?.productVersion) {
    const segments = [`${co.product}/${co.productVersion}`];
    if (co.userAgentExtra) {
      for (const [key, value] of Object.entries(co.userAgentExtra)) {
        segments.push(`${key}/${String(value)}`);
      }
    }
    appkitUserAgent = segments.join(" ");
  }
  const base = newFetchHttpClient();
  return {
    send(request) {
      if (appkitUserAgent) {
        const existing = request.headers.get("User-Agent");
        request.headers.set(
          "User-Agent",
          existing ? `${appkitUserAgent} ${existing}` : appkitUserAgent,
        );
      }
      return sendWithRetry(base, request);
    },
  };
}

// The legacy SDK's retry policy: 429, or an error body naming a transient
// failure; backoff of `attempt` seconds plus jitter, capped at 10s, for up to
// 300s in total. The modular SDK retries nothing outside long-running waits.
const RETRY_TIMEOUT_MS = 300_000;
const TRANSIENT_ERROR_MESSAGES = [
  "com.databricks.backend.manager.util.UnknownWorkerEnvironmentException",
  "does not have any associated worker environments",
  "There is no worker environment with id",
  "Unknown worker environment",
  "ClusterNotReadyException",
  "connection reset by peer",
  "TLS handshake timeout",
  "connection refused",
  "Unexpected error",
  "i/o timeout",
];

async function sendWithRetry(
  base: HttpClient,
  request: Parameters<HttpClient["send"]>[0],
): ReturnType<HttpClient["send"]> {
  // A streamed body (e.g. a file upload) can only be sent once.
  if (request.body instanceof ReadableStream) return base.send(request);
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    const response = await base.send(request);
    if (response.statusCode < 400) return response;
    const body = new Uint8Array(
      await new Response(response.body).arrayBuffer(),
    );
    const text = new TextDecoder().decode(body);
    const retryable =
      response.statusCode === 429 ||
      TRANSIENT_ERROR_MESSAGES.some((m) => text.includes(m));
    const waitMs = Math.min(attempt * 1000 + 50 + Math.random() * 700, 10_000);
    if (
      !retryable ||
      request.signal?.aborted ||
      Date.now() + waitMs > deadline
    ) {
      return { ...response, body: new Response(body).body };
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** A raw REST call against the workspace host. */
export interface WorkspaceRequest {
  method: string;
  /** Path on the workspace host, e.g. `/api/2.0/preview/scim/v2/Me`. */
  path: string;
  query?: Record<string, string>;
  headers?: Headers;
  body?: HttpRequest["body"];
  signal?: AbortSignal;
}

/** Host, auth headers, and raw requests resolved exactly like the modular clients. */
export interface WorkspaceAuth {
  /** Scheme-normalized workspace host, without a trailing slash. */
  getHost(): Promise<string>;
  /** Set the auth header(s) (e.g. `Authorization`) on `headers`. */
  authenticate(headers: Headers): Promise<void>;
  /**
   * Send a request through the modular transport (AppKit User-Agent + auth).
   * Returns the raw `Response` (body unread, so it can stream); throws
   * {@link ApiError} on a non-2xx status.
   */
  request(req: WorkspaceRequest): Promise<Response>;
}

/**
 * Build host/credential resolution from {@link mapToClientOptions}, mirroring
 * the modular SDK's `resolveClientConfig` (sdk-warehouses `dist/v1/transport.js`):
 * resolve the profile from config file + env, explicit options win, and fall
 * back to `defaultCredentials` over the resolved profile. Resolved once, lazily;
 * a failed resolution is retried on the next call.
 */
export function buildWorkspaceAuth(
  opts: WorkspaceClientOptions,
): WorkspaceAuth {
  const options = mapToClientOptions(opts);
  const transport = options.httpClient ?? newFetchHttpClient();
  let resolved: Promise<{ host: string; credentials: Credentials }> | undefined;
  const resolveOnce = () => {
    resolved ??= (async () => {
      const profile = await resolve(options.profileOptions);
      const host = normalizeHost(options.host ?? profile.host)?.replace(
        /\/+$/,
        "",
      );
      if (!host) throw new Error("Host is required.");
      const credentials =
        options.credentials ??
        defaultCredentials({ profile: { ...profile, host } });
      return { host, credentials };
    })().catch((e) => {
      resolved = undefined;
      throw e;
    });
    return resolved;
  };
  const authenticate = async (headers: Headers) => {
    const { credentials } = await resolveOnce();
    for (const h of await credentials.authHeaders()) {
      headers.set(h.key, h.value);
    }
  };
  return {
    getHost: async () => (await resolveOnce()).host,
    authenticate,
    async request(req) {
      const url = new URL(req.path, (await resolveOnce()).host);
      for (const [k, v] of Object.entries(req.query ?? {})) {
        url.searchParams.set(k, v);
      }
      const headers = new Headers(req.headers);
      await authenticate(headers);
      const res = await transport.send({
        url: url.toString(),
        method: req.method,
        headers,
        body: req.body,
        signal: req.signal,
      });
      // `Response` rejects any body (even empty) on null-body statuses.
      const nullBody = [204, 205, 304].includes(res.statusCode);
      const response = new Response(nullBody ? null : res.body, {
        status: res.statusCode,
        // The modular transport drops the reason phrase; legacy error messages
        // include it (see toApiError).
        statusText: STATUS_CODES[res.statusCode],
        headers: res.headers,
      });
      if (!response.ok) throw await toApiError(response);
      return response;
    },
  };
}

/**
 * Same error class the legacy `apiClient.request` threw, so existing catch
 * sites (`instanceof ApiError`, `.statusCode`, `.errorCode`) keep working.
 * Message + code follow the legacy `parseErrorFromResponse` so callers that
 * surface `err.message` (e.g. the serving plugin's 502 body) are unchanged:
 * a body without both `error_code` and `message` (plain text, HTML, or a
 * model-specific error JSON) becomes `Response from server (<status text>) <body>`.
 */
async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let json:
    | { error_code?: string; message?: string; error?: string; details?: [] }
    | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON error body (HTML or plain text).
  }
  if (json?.message && json.error_code) {
    return new ApiError(
      json.error || json.message,
      json.error_code,
      response.status,
      json,
      json.details ?? [],
    );
  }
  const html =
    text.match(/<pre>(.*)<\/pre>/) ??
    text.match(/<title>(Error \d+.*?)<\/title>/);
  return new ApiError(
    html
      ? html[1].trim().replace(/([\s.])*$/, "")
      : `Response from server (${response.statusText}) ${text}`,
    response.statusText || "UNKNOWN",
    response.status,
    json ?? text,
    [],
  );
}

/** Build a modular Warehouses client from wrapper options. */
export function buildWarehousesClient(
  opts: WorkspaceClientOptions,
): WarehousesClient {
  return new WarehousesClient(mapToClientOptions(opts));
}

/** Build a modular Statement Execution client from wrapper options. */
export function buildStatementExecutionClient(
  opts: WorkspaceClientOptions,
): StatementExecutionClient {
  return new StatementExecutionClient(mapToClientOptions(opts));
}

// The modular SDK's error class, for tests that must throw what typed calls
// really throw (status in `httpStatusCode`, not the wrapper's `statusCode`).
export { ApiError as ModularApiError } from "@databricks/sdk-core/apierror";

/**
 * Build a modular SCIM client from wrapper options. Backs the facade's
 * `currentUser` accessor: legacy `currentUser.me()` is `ScimClient.me({})`.
 */
export function buildScimClient(opts: WorkspaceClientOptions): ScimClient {
  return new ScimClient(mapToClientOptions(opts));
}

/** Build a modular Apps client from wrapper options. */
export function buildAppsClient(opts: WorkspaceClientOptions): AppsClient {
  return lazyClient(
    () => import("@databricks/sdk-apps/v1").then((m) => m.AppsClient),
    mapToClientOptions(opts),
  );
}

/**
 * Defer loading an SDK client's module until its first method call, so app
 * boot doesn't pay for clients it never uses. Generated methods return either
 * a Promise or (`*Iter`) an AsyncGenerator, so each proxied call returns the
 * pending result as a Promise that is also async-iterable.
 */
function lazyClient<T extends object>(
  load: () => Promise<new (options: ClientOptions) => T>,
  options: ClientOptions,
): T {
  let client: Promise<T> | undefined;
  return new Proxy({} as T, {
    get(_target, prop) {
      // Not thenable, or `await facade.someClient` would hang.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (...args: unknown[]) => {
        client ??= load().then((Client) => new Client(options));
        const result = client.then((c) =>
          (c as Record<string, (...a: unknown[]) => unknown>)[prop](...args),
        );
        return Object.assign(result, {
          async *[Symbol.asyncIterator]() {
            yield* (await result) as AsyncIterable<unknown>;
          },
        });
      };
    },
  });
}

/** Build a modular Genie client from wrapper options. */
export function buildGenieClient(opts: WorkspaceClientOptions): GenieClient {
  return lazyClient(
    () => import("@databricks/sdk-genie/v1").then((m) => m.GenieClient),
    mapToClientOptions(opts),
  );
}

/** Build a modular Jobs (API 2.2) client from wrapper options. */
export function buildJobsClient(opts: WorkspaceClientOptions): JobsClient {
  return lazyClient(
    () => import("@databricks/sdk-jobs/v2").then((m) => m.JobsClient),
    mapToClientOptions(opts),
  );
}

/**
 * Build a modular Files client from wrapper options. `getFileMetadata` is not
 * used: its generated HEAD call parses the (empty) body and drops the response
 * headers that carry the metadata, so the connector issues that HEAD through
 * {@link WorkspaceAuth.request} instead.
 */
export function buildFilesClient(opts: WorkspaceClientOptions): FilesClient {
  return lazyClient(
    () => import("@databricks/sdk-files/v2").then((m) => m.FilesClient),
    mapToClientOptions(opts),
  );
}

/**
 * Build a modular Vector Search client from wrapper options. Query calls rely
 * on the sdk-vectorsearch pnpm patch (`debugLevel` / `debugInfo`, `bigint` rows).
 */
export function buildVectorSearchClient(
  opts: WorkspaceClientOptions,
): VectorSearchClient {
  return lazyClient(
    () =>
      import("@databricks/sdk-vectorsearch/v1").then(
        (m) => m.VectorSearchClient,
      ),
    mapToClientOptions(opts),
  );
}

/** Build a modular Model Serving (serving endpoints) client from wrapper options. */
export function buildModelServingClient(
  opts: WorkspaceClientOptions,
): ModelServingClient {
  return lazyClient(
    () =>
      import("@databricks/sdk-modelserving/v1").then(
        (m) => m.ModelServingClient,
      ),
    mapToClientOptions(opts),
  );
}

/** Build a modular MLflow Experiments client from wrapper options. */
export function buildExperimentsClient(
  opts: WorkspaceClientOptions,
): ExperimentsClient {
  return lazyClient(
    () =>
      import("@databricks/sdk-experiments/v1").then((m) => m.ExperimentsClient),
    mapToClientOptions(opts),
  );
}

/** Build a modular Unity Catalog Tables client from wrapper options. */
export function buildTablesClient(opts: WorkspaceClientOptions): TablesClient {
  return lazyClient(
    () => import("@databricks/sdk-uc-tables/v1").then((m) => m.TablesClient),
    mapToClientOptions(opts),
  );
}

/** Build a modular Unity Catalog Volumes client from wrapper options. */
export function buildVolumesClient(
  opts: WorkspaceClientOptions,
): VolumesClient {
  return lazyClient(
    () => import("@databricks/sdk-uc-volumes/v1").then((m) => m.VolumesClient),
    mapToClientOptions(opts),
  );
}

/** Build a modular Unity Catalog Functions client from wrapper options. */
export function buildFunctionsClient(
  opts: WorkspaceClientOptions,
): FunctionsClient {
  return lazyClient(
    () =>
      import("@databricks/sdk-uc-functions/v1").then((m) => m.FunctionsClient),
    mapToClientOptions(opts),
  );
}

/** Build a modular Unity Catalog Connections client from wrapper options. */
export function buildConnectionsClient(
  opts: WorkspaceClientOptions,
): ConnectionsClient {
  return lazyClient(
    () =>
      import("@databricks/sdk-uc-connections/v1").then(
        (m) => m.ConnectionsClient,
      ),
    mapToClientOptions(opts),
  );
}

/** Build a modular Lakebase (provisioned) Database client from wrapper options. */
export function buildDatabaseClient(
  opts: WorkspaceClientOptions,
): DatabaseClient {
  return lazyClient(
    () => import("@databricks/sdk-database/v1").then((m) => m.DatabaseClient),
    mapToClientOptions(opts),
  );
}

/**
 * Resolve a `~/.databrickscfg` profile (+ env overlay, unless disabled). Exposed
 * so the CLI can read a profile offline without importing the SDK directly.
 */
export { resolve as resolveProfile } from "@databricks/sdk-core/profiles";

/**
 * Build a modular Lakebase Postgres (autoscaling: projects, branches,
 * endpoints) client from wrapper options. Distinct from the provisioned
 * `/api/2.0/database` instance API.
 */
export function buildPostgresClient(
  opts: WorkspaceClientOptions,
): PostgresClient {
  return lazyClient(
    () => import("@databricks/sdk-postgres/v1").then((m) => m.PostgresClient),
    mapToClientOptions(opts),
  );
}

// ── Client type re-exports (for the facade accessor types) ───────────────
export type { DatabaseClient } from "@databricks/sdk-database/v1";
export type { ExperimentsClient } from "@databricks/sdk-experiments/v1";
export type { AppsClient } from "@databricks/sdk-apps/v1";
export type { FilesClient } from "@databricks/sdk-files/v2";
export type {
  DirectoryEntry as FilesDirectoryEntry,
  DownloadFileResponse as FilesDownloadResponse,
} from "@databricks/sdk-files/v2";
export type { GenieClient } from "@databricks/sdk-genie/v1";
export type { JobsClient } from "@databricks/sdk-jobs/v2";
export type { ModelServingClient } from "@databricks/sdk-modelserving/v1";
export type { PostgresClient } from "@databricks/sdk-postgres/v1";
export type { ScimClient } from "@databricks/sdk-scim/v1";
export type { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
export type { FunctionsClient } from "@databricks/sdk-uc-functions/v1";
export type { ConnectionsClient } from "@databricks/sdk-uc-connections/v1";
export type { TablesClient } from "@databricks/sdk-uc-tables/v1";
export type { VolumesClient } from "@databricks/sdk-uc-volumes/v1";
export type { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
export type { WarehousesClient } from "@databricks/sdk-warehouses/v1";

// ── Model type re-exports ────────────────────────────────────────────────
// AppKit modules import request/response/enum types from the wrapper rather
// than the SDK, so the import boundary holds. Type-only: the connector compares
// state against string literals, which satisfy the SDK's `Enum | (string & {})`
// field unions — no runtime enum values needed.
export type {
  ConnectionInfo,
  GetConnectionRequest,
  ListConnectionsRequest,
  ListConnectionsResponse,
} from "@databricks/sdk-uc-connections/v1";
export type {
  ColumnInfo,
  Disposition,
  ExecuteStatementRequest,
  ExternalLink,
  Format,
  ResultData,
  ResultManifest,
  Schema,
  ServiceError,
  StatementParameter,
  StatementResponse,
  StatementStatus,
  StatementStatus_State,
} from "@databricks/sdk-statementexecution/v1";
export type {
  DatabaseCredential,
  DatabaseInstance,
  GenerateDatabaseCredentialRequest,
  ListDatabaseInstancesRequest,
  ListDatabaseInstancesResponse,
} from "@databricks/sdk-database/v1";
export type {
  App,
  ListAppsRequest,
  ListAppsResponse,
} from "@databricks/sdk-apps/v1";
export type {
  GenieGetMessageQueryResultResponse,
  GenieMessage,
} from "@databricks/sdk-genie/v1";
export type {
  FunctionInfo,
  GetFunctionRequest,
} from "@databricks/sdk-uc-functions/v1";
export type {
  Experiment,
  ListExperimentsRequest,
  ListExperimentsResponse,
} from "@databricks/sdk-experiments/v1";
export type {
  BaseRun,
  CancelRunRequest,
  GetJobRequest,
  GetJobResponse,
  GetRunOutputRequest,
  GetRunOutputResponse,
  GetRunRequest,
  GetRunResponse,
  ListRunsRequest,
  RunNowRequest,
  RunNowResponse,
  SubmitRunRequest,
  SubmitRunResponse,
} from "@databricks/sdk-jobs/v2";
export type {
  GetInferenceEndpointRequest,
  InferenceEndpoint,
  InferenceEndpointDetailed,
  ListInferenceEndpointsRequest,
  ListInferenceEndpointsResponse,
} from "@databricks/sdk-modelserving/v1";
export type {
  EndpointHealth,
  EndpointInfo,
  EndpointState,
  GetWarehouseResponse,
} from "@databricks/sdk-warehouses/v1";
export type {
  QueryVectorIndexRequest,
  QueryVectorIndexResponse,
} from "@databricks/sdk-vectorsearch/v1";
export type {
  GetVolumeRequest,
  VolumeInfo,
} from "@databricks/sdk-uc-volumes/v1";
