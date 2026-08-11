import type { Span, SpanOptions } from "@opentelemetry/api";
import type { IAppRouter } from "shared";
import { vi } from "vitest";
import type { ServiceContextState } from "../context/service-context";
import { ServiceContext } from "../context/service-context";
import type { UserContext } from "../context/user-context";
import type { InstrumentConfig, ITelemetry } from "../telemetry/types";

// Test fixtures intentionally use loose shapes; `noExplicitAny` is disabled
// repo-wide (see biome.json), so a local alias keeps the intent readable.
type Any = any;

/**
 * Creates a mock telemetry provider for testing. Every span/meter/logger is a
 * `vi.fn()` no-op, so plugins that trace, count, or log run without a live
 * OpenTelemetry pipeline. Passed into {@link mockPluginContext} as the one
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
 * Creates a mock Express request object. Carries a default mock
 * WorkspaceClient (SQL succeeds, warehouse is RUNNING) on both the user and
 * service-principal client slots; override any field via `overrides`.
 */
export function createMockRequest(overrides: Any = {}) {
  const mockWorkspaceClient = {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
    // Analytics route now calls `warehouses.get` before issuing SQL to
    // ensure the warehouse is RUNNING. Default to RUNNING so existing
    // tests that only care about SQL behaviour aren't affected.
    warehouses: {
      get: vi.fn().mockResolvedValue({ state: "RUNNING" }),
      start: vi.fn().mockResolvedValue(undefined),
    },
  };

  const req = {
    params: {},
    query: {},
    body: {},
    headers: {},
    userWorkspaceClient: mockWorkspaceClient,
    serviceWorkspaceClient: mockWorkspaceClient,
    getWarehouseId: vi.fn().mockResolvedValue("test-warehouse-id"),
    getWorkspaceId: vi.fn().mockResolvedValue("test-workspace-id"),
    header: function (name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...overrides,
  };
  return req;
}

/**
 * Creates a mock Express response object. `write`/`send`/`setHeader` flip
 * `headersSent`, `end` flips `writableEnded` and fires any `close` listener —
 * enough for streaming handlers that branch on those flags.
 */
export function createMockResponse() {
  const eventListeners: Record<string, Array<(...args: Any[]) => void>> = {};

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
    end: vi.fn(function (this: Any) {
      this.writableEnded = true;
      // Trigger 'close' event when end is called
      if (eventListeners.close) {
        for (const handler of eventListeners.close) {
          handler();
        }
      }
      return this;
    }),
    write: vi.fn(function (this: Any) {
      this.headersSent = true;
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
 * Creates a default mock WorkspaceClient for testing (SQL succeeds, warehouse
 * RUNNING).
 */
export function createMockWorkspaceClient() {
  return {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
    // Analytics route now calls `warehouses.get` before issuing SQL to
    // ensure the warehouse is RUNNING. Default to RUNNING so existing
    // tests that only care about SQL behaviour aren't affected.
    warehouses: {
      get: vi.fn().mockResolvedValue({ state: "RUNNING" }),
      start: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * Builds a {@link ServiceContextState} for testing without touching the
 * singleton. Use with {@link mockServiceContext} to install it.
 */
export function createMockServiceContext(options: TestContextOptions = {}) {
  const mockWorkspaceClient = createMockWorkspaceClient();

  const serviceContext: ServiceContextState = {
    client: (options.serviceDatabricksClient || mockWorkspaceClient) as Any,
    serviceUserId: options.serviceUserId || "test-service-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
  };

  return serviceContext;
}

/**
 * Creates a mock UserContext for testing.
 */
export function createMockUserContext(
  options: TestContextOptions = {},
): UserContext {
  const mockWorkspaceClient = createMockWorkspaceClient();

  return {
    client: (options.userDatabricksClient || mockWorkspaceClient) as Any,
    userId: options.userId || "test-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
    isUserContext: true,
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
  const serviceContext = createMockServiceContext(options);

  const getSpy = vi
    .spyOn(ServiceContext, "get")
    .mockReturnValue(serviceContext);

  const initSpy = vi
    .spyOn(ServiceContext, "initialize")
    .mockResolvedValue(serviceContext);

  const isInitializedSpy = vi
    .spyOn(ServiceContext, "isInitialized")
    .mockReturnValue(true);

  // Mock createUserContext to return a test user context
  const createUserContextSpy = vi
    .spyOn(ServiceContext, "createUserContext")
    .mockImplementation((_token: string, userId: string, userName?: string) => {
      const mockWorkspaceClient = createMockWorkspaceClient();
      return {
        client: (options.userDatabricksClient || mockWorkspaceClient) as Any,
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
