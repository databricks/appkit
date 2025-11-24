import type { IAppRouter } from "@databricks-apps/types";
import { vi } from "vitest";
import type { RequestContext } from "@databricks-apps/server";

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
    userName: "test-user",
    warehouseId: Promise.resolve("test-warehouse-id"),
    workspaceId: Promise.resolve("test-workspace-id"),
    ...context,
  };

  // Use vi.spyOn to mock getRequestContext
  const serverModule = await import("@databricks-apps/server");
  const spy = vi
    .spyOn(serverModule, "getRequestContext")
    .mockReturnValue(defaultContext);

  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
