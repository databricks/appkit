import type { IAppRouter } from "shared";
import type {
  InstrumentConfig,
  ITelemetry,
} from "../packages/appkit/src/telemetry/types";
import type { ServiceContextState } from "../packages/appkit/src/context/service-context";
import type { UserContext } from "../packages/appkit/src/context/user-context";
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
 * Context options for running tests with mocked service/user context
 */
export interface TestContextOptions {
  /** Mock WorkspaceClient for service principal operations */
  serviceDatabricksClient?: any;
  /** Mock WorkspaceClient for user operations */
  userDatabricksClient?: any;
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
 * Creates a default mock WorkspaceClient for testing
 */
export function createMockWorkspaceClient() {
  return {
    statementExecution: {
      executeStatement: vi.fn().mockResolvedValue({
        status: { state: "SUCCEEDED" },
        result: { data: [] },
      }),
    },
  };
}

/**
 * Creates a mock ServiceContext for testing.
 * Call this in beforeEach to set up the ServiceContext mock.
 */
export function createMockServiceContext(options: TestContextOptions = {}) {
  const mockWorkspaceClient = createMockWorkspaceClient();

  const serviceContext: ServiceContextState = {
    client: (options.serviceDatabricksClient || mockWorkspaceClient) as any,
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
    client: (options.userDatabricksClient || mockWorkspaceClient) as any,
    userId: options.userId || "test-user",
    warehouseId: Promise.resolve(options.warehouseId || "test-warehouse-id"),
    workspaceId: Promise.resolve(options.workspaceId || "test-workspace-id"),
    isUserContext: true,
  };
}

/**
 * Mocks the ServiceContext singleton for testing.
 * Should be called in beforeEach.
 *
 * @returns Object with spies that can be used to restore the mocks
 */
export async function mockServiceContext(options: TestContextOptions = {}) {
  const serviceContext = createMockServiceContext(options);

  const contextModule = await import(
    "../packages/appkit/src/context/service-context"
  );

  const getSpy = vi
    .spyOn(contextModule.ServiceContext, "get")
    .mockReturnValue(serviceContext);

  const initSpy = vi
    .spyOn(contextModule.ServiceContext, "initialize")
    .mockResolvedValue(serviceContext);

  const isInitializedSpy = vi
    .spyOn(contextModule.ServiceContext, "isInitialized")
    .mockReturnValue(true);

  // Mock createUserContext to return a test user context
  const createUserContextSpy = vi
    .spyOn(contextModule.ServiceContext, "createUserContext")
    .mockImplementation((_token: string, userId: string, userName?: string) => {
      const mockWorkspaceClient = createMockWorkspaceClient();
      return {
        client: (options.userDatabricksClient || mockWorkspaceClient) as any,
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
 * Runs a test function within a mocked service context.
 * This sets up the ServiceContext mock, runs the function, and restores the mock.
 */
export async function runWithRequestContext<T>(
  fn: () => T | Promise<T>,
  context?: TestContextOptions,
): Promise<T> {
  const mocks = await mockServiceContext(context);

  try {
    return await fn();
  } finally {
    mocks.restore();
  }
}
