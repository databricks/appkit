/**
 * Low-level authenticated HTTP helper.
 *
 * Composes `@databricks/sdk-core/http` (raw fetch transport) and
 * `@databricks/sdk-auth` (credential → headers) to provide a `request()`
 * with the same shape as the old SDK's `apiClient.request(...)`. Callers
 * that genuinely need raw HTTP (SCIM Me header probe, serving SSE,
 * internal telemetry) port over with a one-line import swap and no
 * semantic change.
 *
 * Native `AbortSignal` only — no `Context` / `CancellationToken` bridge.
 *
 * --- Upstream packaging-bug workaround ---
 * The modular SDK v0.1.0-dev.* line ships dist files with extensionless
 * relative imports (`from './http'` rather than `'./http.js'`), which
 * Node's native ESM resolver rejects with `ERR_MODULE_NOT_FOUND`. We
 * patch this locally via pnpm patches in `patches/@databricks__sdk-*.patch`
 * (applied via `package.json` `patchedDependencies`). TODO(prod): drop
 * the patches once upstream publishes a fix.
 */
import type { Credentials } from "@databricks/sdk-auth";
import {
  type HttpClient,
  type HttpRequest,
  newFetchHttpClient,
} from "@databricks/sdk-core/http";

/**
 * Mirrors the old SDK's `apiClient.request(...)` arguments. We deliberately
 * keep the shape (snake-case absent; old keys preserved) so existing call
 * sites move over without semantic edits.
 */
export interface RequestOptions {
  /** Databricks REST path, leading slash included (e.g. "/api/2.0/sql/warehouses"). */
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  headers?: Headers;
  payload?: unknown;
  /** Query string parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * When true, the response is returned as `{ contents: ReadableStream<Uint8Array> }`
   * instead of parsed as JSON. Used for SSE streaming and binary downloads.
   */
  raw?: boolean;
  /**
   * When set, the response headers with these names are returned as a
   * key/value record. Used for the SCIM Me probe to read
   * `x-databricks-org-id`.
   */
  responseHeaders?: string[];
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/** Returned when `raw: true` is set. */
export interface RawResponse {
  contents: ReadableStream<Uint8Array> | null;
}

/**
 * Authenticated HTTP client. Composes `@databricks/sdk-core/http` and
 * `@databricks/sdk-auth` per the modular SDK design.
 */
export class AppKitHttpClient {
  readonly #host: () => string;
  readonly #credentials: () => Credentials;
  readonly #httpClient: HttpClient;

  constructor(opts: {
    /** Resolves the workspace host lazily — keeps construction cheap. */
    host: () => string;
    /** Resolves the credentials chain lazily — auth setup may touch the disk. */
    credentials: () => Credentials;
    httpClient?: HttpClient;
  }) {
    this.#host = opts.host;
    this.#credentials = opts.credentials;
    this.#httpClient = opts.httpClient ?? newFetchHttpClient();
  }

  async request(opts: RequestOptions): Promise<unknown> {
    const url = this.#buildUrl(opts.path, opts.query);
    const headers = await this.#buildHeaders(opts.headers);

    const body =
      opts.payload === undefined
        ? null
        : typeof opts.payload === "string"
          ? opts.payload
          : JSON.stringify(opts.payload);

    if (body !== null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const req: HttpRequest = {
      url: url.toString(),
      method: opts.method,
      headers,
      body,
      signal: opts.signal,
    };

    const res = await this.#httpClient.send(req);

    if (res.statusCode >= 400) {
      const text = await readStreamAsText(res.body);
      throw new Error(
        `Databricks API request failed (${res.statusCode}): ${text.slice(0, 500)}`,
      );
      // TODO(prod): throw a wrapper-owned ApiError (sdk-core/apierror) with
      // parsed error code + structured details. PoC throws a generic Error.
    }

    if (opts.responseHeaders) {
      const headersOut: Record<string, string> = {};
      for (const name of opts.responseHeaders) {
        headersOut[name] = res.headers.get(name) ?? "";
      }
      if (res.body) await res.body.cancel().catch(() => {});
      return headersOut;
    }

    if (opts.raw) {
      return { contents: res.body } satisfies RawResponse;
    }

    if (res.statusCode === 204 || res.headers.get("content-length") === "0") {
      return {};
    }

    const text = await readStreamAsText(res.body);
    return text ? JSON.parse(text) : {};
  }

  #buildUrl(path: string, query: RequestOptions["query"]): URL {
    const host = this.#host();
    const base = host.startsWith("http") ? host : `https://${host}`;
    const url = new URL(path, base);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  async #buildHeaders(extra?: Headers): Promise<Headers> {
    const headers = new Headers(extra);
    const authHeaders = await this.#credentials().authHeaders();
    for (const { key, value } of authHeaders) {
      headers.set(key, value);
    }
    return headers;
  }
}

async function readStreamAsText(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
