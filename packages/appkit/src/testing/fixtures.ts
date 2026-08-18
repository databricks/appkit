import type { Span, SpanOptions } from "@opentelemetry/api";
import type { IAppRouter } from "shared";
import { afterEach, beforeEach, vi } from "vitest";

import { CacheManager } from "../cache";
import type { ServiceContextState } from "../context/service-context";
import { ServiceContext } from "../context/service-context";
import type { InstrumentConfig, ITelemetry } from "../telemetry/types";
import { createMockWorkspaceClient } from "./mock-workspace-client";

// Test fixtures intentionally use loose shapes; `noExplicitAny` is disabled
// repo-wide (see .oxlintrc.json), so a local alias keeps the intent readable.
type Any = any;

/**
 * Creates a mock telemetry provider for testing. Every span/meter/logger is a
 * `vi.fn()` no-op, so plugins that trace, count, or log run without a live
 * OpenTelemetry pipeline. Passed into {@link createTestPluginContext} as the one
 * injectable production seam.
 */
export function createMockTelemetry(): ITelemetry {
  const mockSpan: Span = {
    addLink: vi.fn(),
    addLinks: vi.fn(),
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
    addEvent: vi.fn(),
    isRecording: vi.fn().mockReturnValue(false),
    spanContext: vi.fn(),
  };

  return {
    getTracer: vi.fn().mockReturnValue({
      startActiveSpan: vi.fn().mockImplementation((...args: Any[]) => {
        const fn = args[args.length - 1];
        if (typeof fn === "function") {
          return fn(mockSpan);
        }
        return undefined;
      }),
    }),
    getMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    }),
    getLogger: vi.fn().mockReturnValue({
      emit: vi.fn(),
    }),
    emit: vi.fn(),
    startActiveSpan: vi
      .fn()
      .mockImplementation(
        async (
          _name: string,
          _options: SpanOptions,
          fn: (span: Span) => Promise<Any>,
          _tracerOptions?: InstrumentConfig,
        ) => {
          return await fn(mockSpan);
        },
      ),
    registerInstrumentations: vi.fn(),
  };
}

/**
 * Creates a mock Express router that captures registered handlers so a test
 * can pull a handler back out by method + path and invoke it directly.
 */
export function createMockRouter(): {
  router: IAppRouter;
  handlers: Record<string, Any>;
  getHandler: (method: string, path: string) => Any;
} {
  const handlers: Record<string, Any> = {};

  const mockRouter = {
    get: vi.fn((path: string, handler: Any) => {
      handlers[`GET:${path}`] = handler;
    }),
    post: vi.fn((path: string, handler: Any) => {
      handlers[`POST:${path}`] = handler;
    }),
    put: vi.fn((path: string, handler: Any) => {
      handlers[`PUT:${path}`] = handler;
    }),
    delete: vi.fn((path: string, handler: Any) => {
      handlers[`DELETE:${path}`] = handler;
    }),
    patch: vi.fn((path: string, handler: Any) => {
      handlers[`PATCH:${path}`] = handler;
    }),
  } as unknown as IAppRouter;

  return {
    router: mockRouter,
    handlers,
    getHandler: (method: string, path: string) =>
      handlers[`${method.toUpperCase()}:${path}`],
  };
}

/**
 * On-behalf-of shorthand for {@link createMockRequest}. `true` uses the default
 * test user; an object picks the identity. Sets the forwarded headers the real
 * `Plugin.asUser` reads (`x-forwarded-access-token`, `x-forwarded-user`, and —
 * when given — `x-forwarded-email`), so an OBO test is one flag instead of
 * hand-rolled headers.
 */
export type OboOption =
  | boolean
  | {
      /** `x-forwarded-user` — defaults to `"test-user"`. */
      userId?: string;
      /** `x-forwarded-access-token` — defaults to `"test-user-token"`. */
      token?: string;
      /** `x-forwarded-email` — omitted unless provided. */
      email?: string;
    };

/**
 * Build the forwarded identity headers an `obo` option implies.
 *
 * Exported so `createTestApp`'s request methods use the same convention as
 * `createMockRequest` rather than a second one.
 *
 * @internal
 */
export function oboHeaders(
  obo: Exclude<OboOption, false>,
): Record<string, string> {
  const opts = obo === true ? {} : obo;
  const headers: Record<string, string> = {
    "x-forwarded-access-token": opts.token ?? "test-user-token",
    "x-forwarded-user": opts.userId ?? "test-user",
  };
  if (opts.email) headers["x-forwarded-email"] = opts.email;
  return headers;
}

/**
 * Creates a mock Express request. Pass `overrides` to set `params`, `query`,
 * `body`, `headers`, etc.
 *
 * For on-behalf-of tests, pass `obo` instead of hand-adding forwarded headers —
 * `createMockRequest({ obo: true })` sets the identity headers the real
 * `asUser` requires. Any explicit `headers` you also pass win over the ones
 * `obo` generates, so you can override a single field.
 *
 * @example
 * ```ts
 * createMockRequest({ obo: true });                 // default test user + token
 * createMockRequest({ obo: { userId: "alice" } });  // pick the user
 * ```
 */
export function createMockRequest(overrides: Any = {}) {
  const { obo, headers: headerOverrides, ...rest } = overrides;

  // `obo` seeds the forwarded identity headers; an explicit `headers` override
  // still wins (merged last) so a test can tweak or drop a single field.
  const headers = {
    ...(obo ? oboHeaders(obo) : {}),
    ...headerOverrides,
  };

  const req = {
    params: {},
    query: {},
    body: {},
    header: function (name: string) {
      return this.headers[name.toLowerCase()];
    },
    // `...rest` keeps the original override power over every default above;
    // `headers` is applied last as the one managed field (obo + overrides).
    ...rest,
    headers,
  };
  return req;
}

/**
 * Creates a mock Express response object. `write`/`send`/`setHeader` flip
 * `headersSent`, `end` flips `writableEnded` and fires any `close` listener —
 * enough for streaming handlers that branch on those flags.
 *
 * Every chunk passed to `write` (and a final chunk to `end`) is captured, so a
 * streaming route's real SSE output can be replayed: pass the response straight
 * to {@link expectStream}, or call `sseResponse()` for a real `Response`.
 *
 * @example Assert what a streaming route emitted
 * ```ts
 * const res = createMockResponse();
 * await plugin._handleStream(req, res);
 * await expectStream(res).toEmit("status", "result");
 * ```
 */
export function createMockResponse() {
  const eventListeners: Record<string, Array<(...args: Any[]) => void>> = {};
  const chunks: string[] = [];

  const res = {
    // Flips to true once headers/body have gone out — mirrors Express so
    // streaming handlers can branch between a JSON error (pre-headers) and
    // aborting the socket (mid-stream).
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn(function (this: Any) {
      this.headersSent = true;
      return this;
    }),
    sendStatus: vi.fn().mockReturnThis(),
    end: vi.fn(function (this: Any, chunk?: unknown) {
      // Express allows `end(chunk)` and `end(callback)`; capture only a data
      // chunk, never the completion callback.
      if (chunk != null && typeof chunk !== "function") {
        chunks.push(String(chunk));
      }
      this.writableEnded = true;
      if (eventListeners.close) {
        for (const handler of eventListeners.close) {
          handler();
        }
      }
      return this;
    }),
    write: vi.fn(function (this: Any, chunk?: unknown) {
      this.headersSent = true;
      if (chunk != null) chunks.push(String(chunk));
      // Return `this` (truthy) rather than a boolean: handlers that gate on
      // backpressure (`if (res.write(buf)) …`) then take the no-wait path.
      return this;
    }),
    setHeader: vi.fn(function (this: Any) {
      this.headersSent = true;
      return this;
    }),
    flushHeaders: vi.fn().mockReturnThis(),
    destroy: vi.fn().mockReturnThis(),
    on: vi.fn(function (
      this: Any,
      event: string,
      handler: (...args: Any[]) => void,
    ) {
      if (!eventListeners[event]) {
        eventListeners[event] = [];
      }
      eventListeners[event].push(handler);
      return this;
    }),
    off: vi.fn(function (
      this: Any,
      event: string,
      handler: (...args: Any[]) => void,
    ) {
      if (eventListeners[event]) {
        eventListeners[event] = eventListeners[event].filter(
          (h) => h !== handler,
        );
      }
      return this;
    }),
    writableEnded: false,
    /**
     * The SSE body captured so far, as a real `Response` — the bridge from a
     * `res.write`-based handler into {@link expectStream}. `expectStream`
     * detects this method and calls it for you, so `expectStream(res)` and
     * `expectStream(res.sseResponse())` are equivalent.
     */
    sseResponse(): Response {
      return new Response(chunks.join(""));
    },
  };
  return res;
}

/**
 * Sets up common environment variables for Databricks testing so code that
 * reads `DATABRICKS_HOST` / `DATABRICKS_WAREHOUSE_ID` finds test values.
 */
export function setupDatabricksEnv(overrides: Record<string, string> = {}) {
  process.env.DATABRICKS_HOST = "https://test.databricks.com";
  process.env.DATABRICKS_WAREHOUSE_ID = "test-warehouse-id";
  Object.assign(process.env, overrides);
}

/**
 * Clears AppKit's process-wide cache singleton so cached values don't leak
 * between tests in the same file.
 *
 * The cache `attach()` seeds is shared by every test in a file (Vitest isolates
 * files, not tests within a file). Call this in `beforeEach` when one test's
 * cached value must not be seen by the next, or mid-test to force a cache miss
 * before asserting a subsequent hit.
 *
 * No-ops when the cache has not been initialized yet, so it is safe to call
 * before any `attach()`.
 *
 * @example
 * ```ts
 * beforeEach(async () => {
 *   await resetTestCache();
 * });
 * ```
 */
export async function resetTestCache(): Promise<void> {
  let cache: ReturnType<typeof CacheManager.getInstanceSync>;
  try {
    cache = CacheManager.getInstanceSync();
  } catch {
    // Not initialized yet — nothing to clear.
    return;
  }
  await cache.clear();
}

/**
 * Context options for running tests with mocked service/user context
 */
export interface TestContextOptions {
  /** Mock WorkspaceClient for service principal operations */
  serviceDatabricksClient?: Any;
  /** Mock WorkspaceClient for user operations */
  userDatabricksClient?: Any;
  /** User ID for user context */
  userId?: string;
  /** Service user ID */
  serviceUserId?: string;
  /** Warehouse ID */
  warehouseId?: string;
  /** Workspace ID */
  workspaceId?: string;
}

/**
 * Builds a {@link ServiceContextState} value for testing without touching the
 * singleton. Internal building block for {@link mockServiceContext}, which
 * installs the state as spies — that installer is the public entry point.
 */
function buildServiceContextState(
  options: TestContextOptions = {},
): ServiceContextState {
  return {
    client: (options.serviceDatabricksClient ||
      createMockWorkspaceClient()) as Any,
    serviceUserId: options.serviceUserId || "test-service-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
  };
}

/**
 * Mocks the `ServiceContext` singleton for testing — spies `get`,
 * `initialize`, `isInitialized`, and `createUserContext` so code that resolves
 * the service principal or an on-behalf-of user context gets test doubles.
 * Call in `beforeEach`; call the returned `restore()` in `afterEach`.
 *
 * @returns The mock context plus the spies and a `restore()` helper.
 */
export function mockServiceContext(options: TestContextOptions = {}) {
  const serviceContext = buildServiceContextState(options);

  const getSpy = vi
    .spyOn(ServiceContext, "get")
    .mockReturnValue(serviceContext);

  const initSpy = vi
    .spyOn(ServiceContext, "initialize")
    .mockResolvedValue(serviceContext);

  const isInitializedSpy = vi
    .spyOn(ServiceContext, "isInitialized")
    .mockReturnValue(true);

  const createUserContextSpy = vi
    .spyOn(ServiceContext, "createUserContext")
    .mockImplementation((_token: string, userId: string, userName?: string) => {
      return {
        client: (options.userDatabricksClient ||
          createMockWorkspaceClient()) as Any,
        userId,
        userName,
        warehouseId: serviceContext.warehouseId,
        workspaceId: serviceContext.workspaceId,
        isUserContext: true,
      };
    });

  return {
    serviceContext,
    getSpy,
    initSpy,
    isInitializedSpy,
    createUserContextSpy,
    restore: () => {
      getSpy.mockRestore();
      initSpy.mockRestore();
      isInitializedSpy.mockRestore();
      createUserContextSpy.mockRestore();
    },
  };
}

/** The handle {@link mockServiceContext} returns (spies + `restore`). */
export type ServiceContextMock = ReturnType<typeof mockServiceContext>;

/**
 * Registers a fresh {@link mockServiceContext} before each test and restores it
 * after — the whole `beforeEach`/`afterEach` dance in one line.
 *
 * Call it at the top of a `describe` block (or module top-level), NOT inside a
 * test: Vitest's `beforeEach`/`afterEach` only register during collection, so a
 * call from within a test body registers nothing for that test.
 *
 * Returns a **live** accessor, not the handle: each `beforeEach` builds fresh
 * spies, so reading `.current` inside a test always sees that test's mock. A
 * handle captured once would go stale after the first hook runs.
 *
 * @example
 * ```ts
 * describe("my plugin", () => {
 *   const ctx = useServiceContextMock({ warehouseId: "wh-1" });
 *
 *   test("resolves the warehouse", async () => {
 *     await myHandler(req, res);
 *     expect(ctx.current.getSpy).toHaveBeenCalled();
 *   });
 * });
 * ```
 *
 * @returns `{ current }` — the active {@link ServiceContextMock} for the test.
 */
export function useServiceContextMock(options: TestContextOptions = {}): {
  readonly current: ServiceContextMock;
} {
  let handle: ServiceContextMock | undefined;

  beforeEach(() => {
    handle = mockServiceContext(options);
  });

  afterEach(() => {
    handle?.restore();
    handle = undefined;
  });

  return {
    get current(): ServiceContextMock {
      if (!handle) {
        throw new Error(
          "useServiceContextMock: no active mock. Call useServiceContextMock() " +
            "at the top of a describe block (not inside a test), and read " +
            "`.current` from within a test.",
        );
      }
      return handle;
    },
  };
}

/**
 * Runs a test function within a mocked service context: installs the mock,
 * runs `fn`, and restores the singleton afterward.
 */
export async function runWithRequestContext<T>(
  fn: () => T | Promise<T>,
  context?: TestContextOptions,
): Promise<T> {
  const mocks = mockServiceContext(context);

  try {
    return await fn();
  } finally {
    mocks.restore();
  }
}

/**
 * Builds a SUCCEEDED SQL statement response with a synthetic statement id,
 * `data_array` rows, and a manifest schema derived from `columns`.
 */
export function createSuccessfulSQLResponse(
  data: Any[][],
  columns: Array<{ name: string; type_name?: string }>,
) {
  return {
    status: { state: "SUCCEEDED" },
    statement_id: `stmt-${Date.now()}`,
    result: {
      data_array: data,
    },
    manifest: {
      schema: {
        columns: columns.map((col) => ({
          name: col.name,
          type_name: col.type_name ?? "STRING",
        })),
      },
    },
  };
}

/** Builds a FAILED SQL statement response carrying `errorMessage`. */
export function createFailedSQLResponse(errorMessage: string) {
  return {
    status: {
      state: "FAILED",
      error: {
        message: errorMessage,
      },
    },
    statement_id: `stmt-${Date.now()}`,
  };
}

/**
 * A WorkspaceClient whose `executeStatement`/`getStatement` are bare `vi.fn()`s
 * (no default resolution) so a test can script exactly what SQL returns.
 * `warehouses.get` defaults to RUNNING.
 *
 * @deprecated Use `createMockWorkspaceClient({ defaults: false })` with
 * `getMockFn(client, "statementExecution.executeStatement")` instead — it fakes
 * the whole facade rather than two services, so a plugin that reaches any other
 * service does not crash.
 *
 * Left byte-for-byte unchanged rather than reimplemented on the new builder,
 * because the semantics differ in a way its one remaining caller can observe:
 * these bare `vi.fn()`s return `undefined` **synchronously**, whereas the new
 * floor returns `Promise<undefined>`.
 */
export function createConfigurableMockWorkspaceClient() {
  const executeStatement = vi.fn();
  const getStatement = vi.fn();
  // Analytics route now calls `warehouses.get` before issuing SQL; default to
  // RUNNING so callers that don't care about warehouse readiness don't have
  // to wire it up.
  const warehousesGet = vi.fn().mockResolvedValue({ state: "RUNNING" });
  const warehousesStart = vi.fn().mockResolvedValue(undefined);

  const client = {
    statementExecution: {
      executeStatement,
      getStatement,
    },
    warehouses: {
      get: warehousesGet,
      start: warehousesStart,
    },
  };

  return {
    client,
    mocks: {
      executeStatement,
      getStatement,
      warehousesGet,
      warehousesStart,
    },
  };
}
