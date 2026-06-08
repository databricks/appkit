import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthenticationError } from "../../../errors";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
  mockRes,
  setupTestEnv,
  teardownTestEnv,
  VOLUMES_CONFIG,
} from "./_test-helpers";

const { mockClient, MockApiError, mockCacheInstance } = vi.hoisted(() => {
  const mockFilesApi = {
    listDirectoryContents: vi.fn(),
    download: vi.fn(),
    getMetadata: vi.fn(),
    upload: vi.fn(),
    createDirectory: vi.fn(),
    delete: vi.fn(),
  };
  const mockClient = {
    files: mockFilesApi,
    config: {
      host: "https://test.databricks.com",
      authenticate: vi.fn(),
    },
  };
  class MockApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "ApiError";
      this.statusCode = statusCode;
    }
  }
  const mockCacheInstance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (_key: unknown[], fn: (signal?: AbortSignal) => Promise<unknown>) =>
        fn(),
    ),
    generateKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
  return { mockClient, MockApiError, mockCacheInstance };
});

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => mockClient),
  ApiError: MockApiError,
}));

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return {
    ...actual,
    getWorkspaceClient: vi.fn(() => mockClient),
    isInUserContext: vi.fn(() => true),
  };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin error handling", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  beforeEach(async () => {
    serviceContextMock = await setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  describe("_handleApiError", () => {
    test("AuthenticationError returns generic 401 (raw message stays server-side)", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new AuthenticationError("Missing token"),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        plugin: "files",
      });
    });

    test("ApiError with 4xx returns standard status text (raw message stays server-side)", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Forbidden", 403),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        statusCode: 403,
        plugin: "files",
      });
    });

    test("ApiError with 404 returns standard status text", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Not found", 404),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Not Found",
        statusCode: 404,
        plugin: "files",
      });
    });

    test("ApiError with 409 Conflict returns standard status text", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Conflict", 409),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: "Conflict",
        statusCode: 409,
        plugin: "files",
      });
    });

    test("ApiError with 5xx returns 500 with fallback message", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Bad Gateway", 502),
        "Operation failed",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Operation failed",
        plugin: "files",
      });
    });

    test("ApiError with statusCode 500 returns 500 with fallback", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Internal error", 500),
        "Fallback",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Fallback",
        plugin: "files",
      });
    });

    test("non-ApiError falls back to 500 with fallback message", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(res, new Error("unknown"), "Fallback");

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Fallback",
        plugin: "files",
      });
    });

    test("non-ApiError exception returns 500 with fallback message", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new TypeError("Cannot read properties of undefined"),
        "Internal Server Error",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Internal Server Error",
        plugin: "files",
      });
    });

    test("AuthenticationError via route returns generic 401 on OBO volume without token", async () => {
      process.env.DATABRICKS_VOLUME_OBO = "/Volumes/catalog/schema/obo";
      const plugin = new FilesPlugin({
        volumes: {
          obo: { auth: "on-behalf-of-user", policy: () => true },
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        await handler(
          {
            params: { volumeKey: "obo" },
            query: {},
            headers: {},
            header: () => undefined,
          },
          res,
        );

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
          error: "Unauthorized",
          plugin: "files",
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
        delete process.env.DATABRICKS_VOLUME_OBO;
      }
    });
  });

  describe("_sendStatusError", () => {
    test("sends standard HTTP status text for known codes", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._sendStatusError(res, 404);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Not Found",
        plugin: "files",
      });
    });

    test("sends 'Unknown Error' for non-standard status codes", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._sendStatusError(res, 999);

      expect(res.status).toHaveBeenCalledWith(999);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unknown Error",
        plugin: "files",
      });
    });
  });
});
