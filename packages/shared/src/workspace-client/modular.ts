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
 * `warehouses`, `statementExecution`, `currentUser` (SCIM), `genie`, `jobs`, `vectorSearch`
 * and `tables` (UC) are migrated, plus the auth + raw-request seam ({@link buildWorkspaceAuth});
 * every other service still routes through `legacy.ts`.
 *
 * NOTE: statementExecution relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-statementexecution@0.46.0.patch`) that restores the
 * undocumented Reyden `attachment` response field, which the SDK's generated
 * unmarshal transform would otherwise strip.
 *
 * NOTE: genie relies on a pinned pnpm patch
 * (`patches/@databricks__sdk-genie@0.54.0.patch`): the generated model types the
 * query result's `data_array` as protobuf `ListValue[]` (`{ values: [...] }`), but
 * the API returns plain `JSON_ARRAY` rows (`[["a", null], ...]`), so the unmarshal
 * schema rejected every real query result. The patch restores `(string | null)[][]`.
 */
import { STATUS_CODES } from "node:http";

import {
  type Credentials,
  newTokenCredentials,
  type Token,
  type TokenCredentials,
  tokenProviderFn,
} from "@databricks/sdk-auth";
import {
  defaultCredentials,
  newM2mCredentials,
  newPatCredentials,
} from "@databricks/sdk-auth/credentials";
import {
  type HttpClient,
  type HttpRequest,
  newFetchHttpClient,
} from "@databricks/sdk-core/http";
import { resolve } from "@databricks/sdk-core/profiles";
import { FilesClient } from "@databricks/sdk-files/v2";
import { GenieClient } from "@databricks/sdk-genie/v1";
import { JobsClient } from "@databricks/sdk-jobs/v2";
import { ModelServingClient } from "@databricks/sdk-modelserving/v1";
import type { ClientOptions } from "@databricks/sdk-options/client";
import { ScimClient } from "@databricks/sdk-scim/v1";
import { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
import { TablesClient } from "@databricks/sdk-uc-tables/v1";
import { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
import { WarehousesClient } from "@databricks/sdk-warehouses/v1";

import { ApiError } from "./errors";
import type { WorkspaceClientOptions } from "./legacy";

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
    const clientId = process.env.DATABRICKS_CLIENT_ID;
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    const envToken = process.env.DATABRICKS_TOKEN;
    if (host && clientId && clientSecret) {
      clientOptions.credentials = withTokenCache(
        newM2mCredentials({ host, clientId, clientSecret }),
      );
    } else if (envToken) {
      clientOptions.credentials = newPatCredentials(envToken);
    }
    // Otherwise leave credentials unset and let the SDK walk its profile-based
    // default chain (local dev with `~/.databrickscfg`).
  }
  const httpClient = buildHttpClient(opts);
  if (httpClient) {
    clientOptions.httpClient = httpClient;
  }
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
function buildHttpClient(opts: WorkspaceClientOptions): HttpClient | undefined {
  const co = opts.clientOptions;
  if (!co?.product || !co?.productVersion) {
    return undefined;
  }
  const segments = [`${co.product}/${co.productVersion}`];
  if (co.userAgentExtra) {
    for (const [key, value] of Object.entries(co.userAgentExtra)) {
      segments.push(`${key}/${String(value)}`);
    }
  }
  const appkitUserAgent = segments.join(" ");
  const base = newFetchHttpClient();
  return {
    send(request) {
      const existing = request.headers.get("User-Agent");
      request.headers.set(
        "User-Agent",
        existing ? `${appkitUserAgent} ${existing}` : appkitUserAgent,
      );
      return base.send(request);
    },
  };
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

/** A raw REST call against the workspace host. */
export interface WorkspaceRequest {
  method: string;
  /** Path on the workspace host, e.g. `/api/2.0/preview/scim/v2/Me`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
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

/**
 * Build a modular SCIM client from wrapper options. Backs the facade's
 * `currentUser` accessor: legacy `currentUser.me()` is `ScimClient.me({})`.
 */
export function buildScimClient(opts: WorkspaceClientOptions): ScimClient {
  return new ScimClient(mapToClientOptions(opts));
}

/** Build a modular Genie client from wrapper options. */
export function buildGenieClient(opts: WorkspaceClientOptions): GenieClient {
  return new GenieClient(mapToClientOptions(opts));
}

/** Build a modular Jobs (API 2.2) client from wrapper options. */
export function buildJobsClient(opts: WorkspaceClientOptions): JobsClient {
  return new JobsClient(mapToClientOptions(opts));
}

/**
 * Build a modular Files client from wrapper options. `getFileMetadata` is not
 * used: its generated HEAD call parses the (empty) body and drops the response
 * headers that carry the metadata, so the connector issues that HEAD through
 * {@link WorkspaceAuth.request} instead.
 */
export function buildFilesClient(opts: WorkspaceClientOptions): FilesClient {
  return new FilesClient(mapToClientOptions(opts));
}

/**
 * Build a modular Vector Search client from wrapper options. Only index metadata
 * (`getVectorIndex`) goes typed: the query endpoints use the raw `request()`
 * seam because the generated model drops `debug_level` / `debug_info`.
 */
export function buildVectorSearchClient(
  opts: WorkspaceClientOptions,
): VectorSearchClient {
  return new VectorSearchClient(mapToClientOptions(opts));
}

/** Build a modular Model Serving (serving endpoints) client from wrapper options. */
export function buildModelServingClient(
  opts: WorkspaceClientOptions,
): ModelServingClient {
  return new ModelServingClient(mapToClientOptions(opts));
}

/** Build a modular Unity Catalog Tables client from wrapper options. */
export function buildTablesClient(opts: WorkspaceClientOptions): TablesClient {
  return new TablesClient(mapToClientOptions(opts));
}

// ── Client type re-exports (for the facade accessor types) ───────────────
export type { FilesClient } from "@databricks/sdk-files/v2";
export type { GenieClient } from "@databricks/sdk-genie/v1";
export type { JobsClient } from "@databricks/sdk-jobs/v2";
export type { ModelServingClient } from "@databricks/sdk-modelserving/v1";
export type { ScimClient } from "@databricks/sdk-scim/v1";
export type { StatementExecutionClient } from "@databricks/sdk-statementexecution/v1";
export type { TablesClient } from "@databricks/sdk-uc-tables/v1";
export type { VectorSearchClient } from "@databricks/sdk-vectorsearch/v1";
export type { WarehousesClient } from "@databricks/sdk-warehouses/v1";

// ── Model type re-exports ────────────────────────────────────────────────
// AppKit modules import request/response/enum types from the wrapper rather
// than the SDK, so the import boundary holds. Type-only: the connector compares
// state against string literals, which satisfy the SDK's `Enum | (string & {})`
// field unions — no runtime enum values needed.
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
  GenieGetMessageQueryResultResponse,
  GenieMessage,
} from "@databricks/sdk-genie/v1";
export type {
  GetJobRequest,
  GetRunRequest,
  ListRunsRequest,
  RunNowRequest,
  SubmitRunRequest,
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
