import type { IAppRouter } from "shared";
import type {
  InstrumentConfig,
  ITelemetry,
} from "../packages/appkit/src/telemetry/types";
import type { RequestContext } from "../packages/appkit/src/utils/databricks-client-middleware";
import { vi } from "vitest";
import type { SpanOptions, Span } from "@opentelemetry/api";

/**
 * Creates a mock telemetry provider for testing
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
      startActiveSpan: vi.fn().mockImplementation((...args: any[]) => {
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
          fn: (span: Span) => Promise<any>,
          _tracerOptions?: InstrumentConfig,
        ) => {
          return await fn(mockSpan);
        },
      ),
    registerInstrumentations: vi.fn(),
  };
}

/**
 * Creates a mock Express router with route handler capturing
 */
export function createMockRouter(): {
  router: IAppRouter;
  handlers: Record<string, any>;
  getHandler: (method: string, path: string) => any;
} {
  const handlers: Record<string, any> = {};

  const mockRouter = {
    get: vi.fn((path: string, handler: any) => {
      handlers[`GET:${path}`] = handler;
    }),
    post: vi.fn((path: string, handler: any) => {
      handlers[`POST:${path}`] = handler;
    }),
    put: vi.fn((path: string, handler: any) => {
      handlers[`PUT:${path}`] = handler;
    }),
    delete: vi.fn((path: string, handler: any) => {
      handlers[`DELETE:${path}`] = handler;
    }),
    patch: vi.fn((path: string, handler: any) => {
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
 * Creates a mock Express request object
 */
export function createMockRequest(overrides: any = {}) {
  const mockWorkspaceClient = {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
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
 * Creates a mock Express response object
 */
export function createMockResponse() {
  const eventListeners: Record<string, Array<(...args: any[]) => void>> = {};

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
    end: vi.fn(function (this: any) {
      this.writableEnded = true;
      // Trigger 'close' event when end is called
      if (eventListeners.close) {
        for (const handler of eventListeners.close) {
          handler();
        }
      }
      return this;
    }),
    write: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn().mockReturnThis(),
    on: vi.fn(function (
      this: any,
      event: string,
      handler: (...args: any[]) => void,
    ) {
      if (!eventListeners[event]) {
        eventListeners[event] = [];
      }
      eventListeners[event].push(handler);
      return this;
    }),
    writableEnded: false,
  };
  return res;
}

/**
 * Sets up common environment variables for Databricks testing
 */
export function setupDatabricksEnv(overrides: Record<string, string> = {}) {
  process.env.DATABRICKS_HOST = "https://test.databricks.com";
  process.env.DATABRICKS_WAREHOUSE_ID = "test-warehouse-id";
  Object.assign(process.env, overrides);
}

/**
 * Runs a test function within a request context
 */
export async function runWithRequestContext<T>(
  fn: () => T | Promise<T>,
  context?: Partial<RequestContext>,
): Promise<T> {
  const mockWorkspaceClient = {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
  };

  const defaultContext: RequestContext = {
    userDatabricksClient: mockWorkspaceClient as any,
    serviceDatabricksClient: mockWorkspaceClient as any,
    userId: "test-user",
    serviceUserId: "test-service-user",
    warehouseId: Promise.resolve("test-warehouse-id"),
    workspaceId: Promise.resolve("test-workspace-id"),
    ...context,
  };

  // Use vi.spyOn to mock getRequestContext and getWorkspaceClient
  const utilsModule = await import(
    "../packages/appkit/src/utils/databricks-client-middleware"
  );

  const contextSpy = vi
    .spyOn(utilsModule, "getRequestContext")
    .mockReturnValue(defaultContext);

  // Also mock getWorkspaceClient to return the appropriate client based on asUser
  const workspaceClientSpy = vi
    .spyOn(utilsModule, "getWorkspaceClient")
    .mockImplementation((asUser: boolean) => {
      if (asUser) {
        if (!defaultContext.userDatabricksClient) {
          throw new Error("User token passthrough is not enabled");
        }
        return defaultContext.userDatabricksClient;
      }
      return defaultContext.serviceDatabricksClient;
    });

  try {
    return await fn();
  } finally {
    contextSpy.mockRestore();
    workspaceClientSpy.mockRestore();
  }
}
