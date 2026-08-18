/**
 * `createTestApp` — boot a real AppKit app with no workspace, no credentials,
 * and no network, then call it over real HTTP.
 *
 * @module
 */

import type { Server } from "node:http";

import type {
  CacheConfig,
  PluginConstructor,
  PluginData,
  PluginMap,
} from "shared";

import { InMemoryStorage } from "../cache/storage/memory";
import { createApp } from "../core/appkit";
import type { WorkspaceClient } from "../workspace-client";
import type { OboOption } from "./fixtures";
import { oboHeaders, setupDatabricksEnv } from "./fixtures";
import type { CreateMockWorkspaceClientOptions } from "./mock-workspace-client";
import { createMockWorkspaceClient } from "./mock-workspace-client";
import { resetAppKitSingletons } from "./reset";

// Test fixtures intentionally use loose shapes; `no-explicit-any` is disabled
// repo-wide (see .oxlintrc.json), so a local alias keeps the intent readable.
type Any = any;

/** Plugin descriptors, exactly as `createApp` takes them. */
type Plugins = PluginData<PluginConstructor, unknown, string>[];

/** Options for {@link createTestApp}. */
export interface CreateTestAppOptions<T extends Plugins> {
  /** The plugins under test, as `createApp` takes them. */
  plugins?: T;

  /**
   * Client responses keyed by dotted path (`"jobs.getRun"`), forwarded to the
   * built-in mock workspace client. Ignored when `client` is supplied.
   */
  responses?: CreateMockWorkspaceClientOptions["responses"];

  /**
   * Use this workspace client instead of the built-in mock. Supplying one means
   * you own its `currentUser.me()` — `ServiceContext.createContext` reads
   * `currentUser.id` off the result and cannot boot without it.
   */
  client?: WorkspaceClient;

  /**
   * Extra environment variables for the boot, restored on `close()`. This is how
   * you satisfy a plugin's declared resource requirements.
   */
  env?: Record<string, string>;

  /**
   * Skip the injected server plugin. No socket is bound and the request methods
   * throw, but plugin setup, resource validation, and teardown still run.
   */
  server?: false;

  /**
   * Override the pinned `NODE_ENV`. Defaults to `"test"`.
   *
   * `"development"` is refused: dev mode routes the injected `port: 0` through
   * `get-port`, where `portNumbers(0, …)` throws a `RangeError`, and it also
   * boots a real Vite dev server, downgrades resource validation to a warning,
   * and stops filtering dev-only plugins.
   */
  nodeEnv?: string;

  /** Cache configuration. Defaults to in-memory, which is what keeps boot offline. */
  cache?: CacheConfig;

  /** Budget for the app's teardown. Defaults to AppKit's programmatic budget. */
  closeTimeoutMs?: number;
}

/** Per-request options for the {@link TestApp} HTTP methods. */
export interface TestRequestOptions {
  /**
   * Request body. A non-string value is JSON-encoded and
   * `content-type: application/json` is set unless `headers` overrides it.
   */
  body?: unknown;
  /** Extra headers. These win over anything the harness sets. */
  headers?: Record<string, string>;
  /**
   * On-behalf-of shorthand, the same convention as `createMockRequest({ obo })`:
   * `true` for the default test user, an object to pick the identity.
   */
  obo?: OboOption;
  /** Abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** A booted test app. */
export interface TestApp<T extends Plugins> {
  /**
   * Plugin exports, keyed by manifest name — `app.plugins.analytics.query(...)`.
   *
   * Deliberately nested rather than spread onto the handle: `get` and `delete`
   * are plausible plugin names, and spreading would collide with the request
   * methods.
   */
  plugins: PluginMap<T>;
  /** The workspace client the app booted with — the same object a handler resolves. */
  client: WorkspaceClient;
  /** e.g. `http://127.0.0.1:54321`. Throws when `server: false`. */
  baseUrl: string;
  /** The bound ephemeral port. Throws when `server: false`. */
  port: number;
  /** The underlying HTTP server, or `undefined` with `server: false`. */
  server?: Server;

  /** Release the app and restore `process.env`. Idempotent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;

  get(path: string, options?: TestRequestOptions): Promise<Response>;
  post(path: string, options?: TestRequestOptions): Promise<Response>;
  put(path: string, options?: TestRequestOptions): Promise<Response>;
  patch(path: string, options?: TestRequestOptions): Promise<Response>;
  delete(path: string, options?: TestRequestOptions): Promise<Response>;
}

/**
 * Resolve the port a server actually bound to.
 *
 * `ServerPlugin.start()` returns as soon as `listen()` has been *invoked*, which
 * is before the bind completes — so `server.address()` is `null` until the
 * `listening` event fires.
 *
 * @internal
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
 * Boot a real AppKit app for testing — real Express wiring, real routes, real
 * resource validation — with no workspace, no credentials, and no network.
 *
 * Use this to test a plugin end-to-end through HTTP. For unit-testing plugin
 * wiring without binding a socket, `createTestPluginContext` is cheaper.
 *
 * What it does **not** check: config values against `manifest.config.schema`.
 * No runtime validator exists for that; `enforceValidation()` checks env-var
 * presence only.
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
    client: suppliedClient,
    env = {},
    server: serverOption,
    nodeEnv = "test",
    cache,
    closeTimeoutMs,
  } = options;

  if (nodeEnv === "development") {
    // Refused rather than worked around: the RangeError from get-port must never
    // reach the caller, and dev mode changes validation and plugin filtering in
    // ways that would make the harness unrepresentative anyway.
    throw new Error(
      'createTestApp: nodeEnv "development" is not supported. Dev mode routes ' +
        "the harness's ephemeral `port: 0` through get-port, which throws a " +
        "RangeError, and it also boots a real Vite dev server, downgrades " +
        "resource validation to a warning, and stops filtering dev-only " +
        "plugins. Pin a port explicitly with your own server plugin if you " +
        "need dev behaviour.",
    );
  }

  // 1. Snapshot wholesale. Restoring a whitelist is fragile — plugins read env
  //    vars the harness cannot enumerate.
  const envSnapshot = { ...process.env };

  /** Put `process.env` back exactly as it was, including keys we added. */
  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  };

  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  try {
    // 2. Pin NODE_ENV away from development (see the guard above).
    process.env.NODE_ENV = nodeEnv;

    // 3. Belt-and-braces on the validation posture. Step 2 already guarantees
    //    it: enforceValidation() computes `shouldThrow = !isDevelopment ||
    //    strict`, so with NODE_ENV pinned away from "development" a missing
    //    required resource throws regardless of this flag. It is set anyway so
    //    the contract survives a future change to the NODE_ENV pin.
    //
    //    There is deliberately no opt-out: an option to downgrade validation to
    //    a warning could not work here, since that path is reachable only in
    //    development mode, which the harness refuses.
    process.env.APPKIT_STRICT_VALIDATION = "true";

    // 4. DATABRICKS_WORKSPACE_ID short-circuits the SCIM probe in
    //    getWorkspaceId, which would otherwise be an apiClient.request call and
    //    pollute request assertions.
    setupDatabricksEnv({
      DATABRICKS_WORKSPACE_ID: "test-workspace-id",
      ...env,
    });

    // 5. Drop any singletons a previous test leaked.
    resetAppKitSingletons();

    // 6. The data-plane fake. createApp({ client }) runs ServiceContext
    //    .createContext for real, which reads currentUser.id — the mock's
    //    built-in currentUser.me default is what makes the boot possible.
    const client = suppliedClient ?? createMockWorkspaceClient({ responses });

    // 7. Inject a server plugin unless the caller supplied one. createApp
    //    auto-adds only uiVariants(), never a server, so without this there is
    //    no listener to fetch against. Reached through a lazy import because
    //    the server plugin runs dotenv.config() at module load — a static
    //    import would mutate a consumer's env merely by importing this kit.
    const hasServer = plugins.some((p) => p?.name === "server");
    const bootPlugins = [...plugins] as Plugins;
    if (serverOption !== false && !hasServer) {
      const { server: serverPlugin } = await import("../plugins/server");
      bootPlugins.push(serverPlugin({ port: 0, host: "127.0.0.1" }));
    }

    // 8. Both extras are load-bearing. Without explicit storage the cache
    //    builds its own workspace client and probes Lakebase over the network;
    //    without the telemetry opt-out, TelemetryReporter fires an
    //    apiClient.request on boot.
    app = await createApp({
      plugins: bootPlugins as Any,
      client,
      cache: cache ?? {
        storage: new InMemoryStorage({ enabled: true } as Any),
      },
      disableInternalTelemetry: true,
    });

    // 9. Resolve the port the OS actually assigned.
    const serverExports = (app as Any).server;
    const httpServer: Server | undefined =
      serverOption === false ? undefined : serverExports?.getServer?.();
    const port = httpServer ? await getListeningPort(httpServer) : undefined;
    const baseUrl = port === undefined ? undefined : `http://127.0.0.1:${port}`;

    const bootedApp = app;
    let closed: Promise<void> | undefined;

    /** Teardown, memoized so repeated calls are safe in nested `finally`s. */
    const close = () => {
      closed ??= (async () => {
        try {
          await (bootedApp as Any).close(
            closeTimeoutMs === undefined ? {} : { timeoutMs: closeTimeoutMs },
          );
        } finally {
          // Belt and braces: close() resets these already, but a caller who
          // supplied their own server plugin may have bypassed parts of it.
          resetAppKitSingletons();
          restoreEnv();
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
      Object.assign(headers, reqOptions.headers ?? {});

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
    // Boot failed — a plugin's setup() threw, or resource validation rejected.
    // Teardown must still run, or the failure leaks env mutations and
    // singletons into every later test in the file.
    try {
      await (app as Any)?.close?.();
    } catch {
      // The boot error is the interesting one; a teardown failure on an
      // half-built app must not mask it.
    }
    resetAppKitSingletons();
    restoreEnv();
    throw err;
  }
}
