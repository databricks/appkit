/**
 * Boot a real AppKit app with no workspace, credentials, or network, then call it
 * over real HTTP.
 */

import type { Server } from "node:http";

import type {
  CacheConfig,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "shared";
import { vi } from "vitest";

import { InMemoryStorage } from "../cache/storage/memory";
import { ServiceContext } from "../context/service-context";
import { createApp } from "../core/appkit";
import type { WorkspaceClient } from "../workspace-client";
import type { OboOption } from "./fixtures";
import { fakeUserContext, oboHeaders, setupDatabricksEnv } from "./fixtures";
import type { CreateMockWorkspaceClientOptions } from "./mock-workspace-client";
import { createMockWorkspaceClient } from "./mock-workspace-client";
import { claimAppKitSingletons, releaseAppKitSingletons } from "./reset";

// Loose shapes are intentional here; `noExplicitAny` is off repo-wide (see
// .oxlintrc.json), so a local alias keeps the intent readable.
type Any = any;

/**
 * One baseline shared by every live harness app, reference-counted.
 *
 * A per-app snapshot does not compose: the second boot captures the first's
 * mutations and whichever closes last re-applies them. Anchoring on the first
 * boot and restoring on the last close makes the result order-independent.
 */
let envBaseline: NodeJS.ProcessEnv | undefined;
let liveHarnessApps = 0;

/** Take the baseline on the first live app. */
function acquireEnvBaseline(): void {
  if (liveHarnessApps === 0) envBaseline = { ...process.env };
  liveHarnessApps += 1;
}

/** Restore the baseline once no apps are left. */
function releaseEnvBaseline(): void {
  liveHarnessApps = Math.max(0, liveHarnessApps - 1);
  if (liveHarnessApps > 0 || !envBaseline) return;

  const baseline = envBaseline;
  envBaseline = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) delete process.env[key];
  }
  Object.assign(process.env, baseline);
}

/** Plugin descriptors, exactly as `createApp` takes them. */
type Plugins = PluginData<PluginConstructor, unknown, string>[];

/** Options for {@link createTestApp}. */
export interface CreateTestAppOptions<T extends Plugins> {
  /** The plugins under test, as `createApp` takes them. */
  plugins?: T;

  /** Dotted-path responses for the built-in mock. Refused when `client` is set. */
  responses?: CreateMockWorkspaceClientOptions["responses"];

  /**
   * Make the built-in mock throw when a path with no declared response is
   * called, rather than resolving `undefined`. Refused when `client` is set —
   * configure it on your own client instead.
   */
  strict?: CreateMockWorkspaceClientOptions["strict"];

  /**
   * Replaces the built-in mock. You then own `currentUser.me()` — boot reads
   * `currentUser.id` and fails without it.
   */
  client?: WorkspaceClient;

  /** Extra env for the boot, restored on `close()`; satisfies declared resources. */
  env?: Record<string, string>;

  /** No socket; setup, validation, and teardown still run, request methods throw. */
  server?: false;

  /**
   * Defaults to `"test"`. `"development"` is refused — it throws a `RangeError`
   * in `get-port` on `port: 0`, boots Vite, and relaxes validation.
   *
   * Beyond refusing `development`, this decides error-response redaction:
   * `errorHandlerMiddleware` returns the real message unless `NODE_ENV` is
   * `production`, where a 5xx becomes `"Server error"`. Pass `"production"` to
   * assert what a deployed app actually returns to a client.
   */
  nodeEnv?: string;

  /** Defaults to in-memory, which is what keeps boot offline. */
  cache?: CacheConfig;

  /** Teardown budget. Defaults to AppKit's programmatic budget. */
  closeTimeoutMs?: number;
}

/** Per-request options for the {@link TestApp} HTTP methods. */
export interface TestRequestOptions {
  /** A non-string value is JSON-encoded with `content-type: application/json`. */
  body?: unknown;
  /** Merged last, so they win over anything the harness sets. */
  headers?: Record<string, string>;
  /** Same convention as `createMockRequest({ obo })`. */
  obo?: OboOption;
  /** Forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** A booted test app. */
export interface TestApp<T extends Plugins> {
  /**
   * Plugin exports by manifest name. Nested rather than spread because `get` and
   * `delete` are plausible plugin names and would collide with the request methods.
   */
  plugins: PluginMap<T>;
  /** The same object a handler resolves at runtime. */
  client: WorkspaceClient;
  /** e.g. `http://127.0.0.1:54321`. Throws when `server: false`. */
  baseUrl: string;
  /** The bound ephemeral port. Throws when `server: false`. */
  port: number;
  /** The underlying HTTP server, or `undefined` with `server: false`. */
  server?: Server;

  /** Release the app and restore env. Idempotent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

  get(path: string, options?: TestRequestOptions): Promise<Response>;
  post(path: string, options?: TestRequestOptions): Promise<Response>;
  put(path: string, options?: TestRequestOptions): Promise<Response>;
  patch(path: string, options?: TestRequestOptions): Promise<Response>;
  delete(path: string, options?: TestRequestOptions): Promise<Response>;
}

/**
 * Point `ServiceContext.createUserContext` at the harness's mock so an `obo`
 * request does not construct a real SDK client from `DATABRICKS_HOST`.
 *
 * Mirrors the `createUserContextSpy` in `fixtures.ts`; returns its restore.
 */
function stubUserContext(client: WorkspaceClient): () => void {
  const spy = vi
    .spyOn(ServiceContext, "createUserContext")
    .mockImplementation((token, userId, userName, userEmail) =>
      fakeUserContext(client, ServiceContext.get())(
        token,
        userId,
        userName,
        userEmail,
      ),
    );
  return () => spy.mockRestore();
}

/**
 * Wait for a server to finish binding and return the port it landed on.
 *
 * Needed with `port: 0`: `start()` returns once `listen()` is invoked, before
 * the bind completes, so `address()` is null until the `listening` event fires.
 * `createTestApp` does this for you — reach for it when hand-rolling a server.
 */
export async function getListeningPort(server: Server): Promise<number> {
  const addr = server.address();
  if (addr && typeof addr === "object" && typeof addr.port === "number") {
    return addr.port;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });
  const ready = server.address();
  if (!ready || typeof ready !== "object") {
    throw new Error("Server is listening but address() returned null");
  }
  return ready.port;
}

/**
 * Boot a real app — real Express wiring, routes, and resource validation — with
 * no workspace, credentials, or network. `createTestPluginContext` is cheaper
 * when you only need to unit-test wiring.
 *
 * Does **not** validate config values against `manifest.config.schema`; no
 * runtime validator exists for that.
 *
 * @example
 * ```ts
 * const app = await createTestApp({ plugins: [myPlugin()] });
 * try {
 *   const res = await app.post("/api/my-plugin/thing", { body: { q: 1 }, obo: true });
 *   await expectStream(res).toEmit("status", "result");
 * } finally {
 *   await app.close();
 * }
 * ```
 */
export async function createTestApp<T extends Plugins>(
  options: CreateTestAppOptions<T> = {},
): Promise<TestApp<T>> {
  const {
    plugins = [] as unknown as T,
    responses,
    strict,
    client: suppliedClient,
    env = {},
    server: serverOption,
    nodeEnv = "test",
    cache,
    closeTimeoutMs,
  } = options;

  if (nodeEnv === "development") {
    throw new Error(
      'createTestApp: nodeEnv "development" is not supported. Dev mode routes ' +
        "the harness's ephemeral `port: 0` through get-port, which throws a " +
        "RangeError, and it also boots a real Vite dev server, downgrades " +
        "resource validation to a warning, and stops filtering dev-only " +
        "plugins. Pin a port explicitly with your own server plugin if you " +
        "need dev behaviour.",
    );
  }

  // Wholesale rather than a whitelist: plugins read vars we cannot enumerate.
  acquireEnvBaseline();

  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let restoreUserContext: (() => void) | undefined;

  try {
    process.env.NODE_ENV = nodeEnv;

    // Redundant while NODE_ENV is pinned, but keeps the throw-on-missing-resource
    // contract if that pin ever changes. No opt-out: the warning path is
    // dev-only, and dev is refused.
    process.env.APPKIT_STRICT_VALIDATION = "true";

    // The workspace ID short-circuits getWorkspaceId's SCIM probe, which would
    // otherwise show up as an apiClient.request call.
    setupDatabricksEnv({
      DATABRICKS_WORKSPACE_ID: "test-workspace-id",
      ...env,
    });

    claimAppKitSingletons();

    // `responses` only seeds the built-in mock, so alongside a caller-supplied
    // client it would silently do nothing. Refuse instead, matching the
    // `server: false` conflict below.
    if (suppliedClient && (responses !== undefined || strict !== undefined)) {
      throw new Error(
        "createTestApp: `responses` and `strict` configure the built-in mock " +
          "client, so they do nothing when you also pass `client`. Drop them " +
          "and configure your own client instead.",
      );
    }

    // Boot runs ServiceContext.createContext for real, which reads
    // currentUser.id — the mock's built-in default is what lets it through.
    const client =
      suppliedClient ?? createMockWorkspaceClient({ responses, strict });

    // createApp({ client }) installs only the service-principal client. An `obo`
    // request reaches ServiceContext.createUserContext, which builds a *real*
    // client from process.env.DATABRICKS_HOST — so the user-scoped path is faked
    // here too, or "no network" is false the moment a handler calls asUser.
    restoreUserContext = stubUserContext(client);

    // createApp never auto-adds a server, so without this there is nothing to
    // fetch. Lazily imported: the plugin runs dotenv.config() at module load, so
    // a static import would mutate a consumer's env on import of this kit.
    const hasServer = plugins.some((p) => p?.name === "server");
    if (serverOption === false && hasServer) {
      // The plugin would still bind a socket while the handle denied one existed.
      throw new Error(
        "createTestApp: `server: false` conflicts with the server plugin in " +
          "`plugins`. Drop one — omit `server: false` to use your plugin, or " +
          "remove the plugin to boot without a socket.",
      );
    }
    const bootPlugins = [...plugins] as Plugins;
    if (serverOption !== false && !hasServer) {
      const { server: serverPlugin } = await import("../plugins/server");
      bootPlugins.push(serverPlugin({ port: 0, host: "127.0.0.1" }));
    }

    // Both extras are required to stay offline: without explicit storage the
    // cache builds its own client and probes Lakebase, and without the opt-out
    // TelemetryReporter fires an apiClient.request on boot.
    app = await createApp({
      plugins: bootPlugins as Any,
      client,
      cache: cache ?? {
        storage: new InMemoryStorage({ enabled: true } as Any),
      },
      disableInternalTelemetry: true,
    });

    const serverExports = (app as Any).server;
    const httpServer: Server | undefined =
      serverOption === false ? undefined : serverExports?.getServer?.();
    const port = httpServer ? await getListeningPort(httpServer) : undefined;
    const baseUrl = port === undefined ? undefined : `http://127.0.0.1:${port}`;

    const bootedApp = app;
    let closed: Promise<void> | undefined;

    /** Memoized, so repeated calls are safe in nested `finally`s. */
    const close = () => {
      closed ??= (async () => {
        try {
          await bootedApp.close(
            closeTimeoutMs === undefined ? {} : { timeoutMs: closeTimeoutMs },
          );
        } finally {
          // No release here: app.close() -> LifecycleManager.close() already
          // drops this app's claim, once. Releasing twice would pull the
          // singletons out from under a still-live sibling app.
          restoreUserContext?.();
          releaseEnvBaseline();
        }
      })();
      return closed;
    };

    const request = async (
      method: string,
      path: string,
      reqOptions: TestRequestOptions = {},
    ): Promise<Response> => {
      if (baseUrl === undefined) {
        throw new Error(
          "createTestApp: no HTTP server was started (server: false), so " +
            `${method} ${path} cannot be issued.`,
        );
      }

      const headers: Record<string, string> = {};
      if (reqOptions.obo) {
        Object.assign(headers, oboHeaders(reqOptions.obo));
      }

      let body: string | undefined;
      if (reqOptions.body !== undefined) {
        if (typeof reqOptions.body === "string") {
          body = reqOptions.body;
        } else {
          body = JSON.stringify(reqOptions.body);
          headers["content-type"] = "application/json";
        }
      }

      // Caller headers last, so an explicit content-type or identity wins.
      // Lowercased first: `Headers` comma-joins case variants instead of
      // replacing, so a mixed-case override would corrupt the value into
      // "alice, bob" rather than win.
      for (const [name, value] of Object.entries(reqOptions.headers ?? {})) {
        headers[name.toLowerCase()] = value;
      }

      return fetch(new URL(path, baseUrl), {
        method,
        headers,
        body,
        signal: reqOptions.signal,
      });
    };

    return {
      plugins: bootedApp as unknown as PluginMap<T>,
      client,
      get baseUrl() {
        if (baseUrl === undefined) {
          throw new Error(
            "createTestApp: no HTTP server was started (server: false).",
          );
        }
        return baseUrl;
      },
      get port() {
        if (port === undefined) {
          throw new Error(
            "createTestApp: no HTTP server was started (server: false).",
          );
        }
        return port;
      },
      server: httpServer,
      close,
      [Symbol.asyncDispose]: close,
      get: (path, o) => request("GET", path, o),
      post: (path, o) => request("POST", path, o),
      put: (path, o) => request("PUT", path, o),
      patch: (path, o) => request("PATCH", path, o),
      delete: (path, o) => request("DELETE", path, o),
    };
  } catch (err) {
    // Teardown must run from the failure path too, or the boot leaks env
    // mutations and singletons into every later test in the file.
    if (app) {
      // No release alongside this: close() drops the claim itself, and a second
      // release would reset singletons a concurrent app is still using.
      try {
        await app.close(
          closeTimeoutMs === undefined ? {} : { timeoutMs: closeTimeoutMs },
        );
      } catch {
        // The boot error is the interesting one; don't let teardown mask it.
      }
    } else {
      // Nothing was booted, so nothing else will drop the claim taken above.
      releaseAppKitSingletons();
    }
    restoreUserContext?.();
    releaseEnvBaseline();
    throw err;
  }
}
