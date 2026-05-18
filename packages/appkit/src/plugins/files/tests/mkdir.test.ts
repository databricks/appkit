import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
  mockReq,
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
    getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
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

describe("FilesPlugin mkdir", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  beforeEach(async () => {
    serviceContextMock = await setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  test("successful mkdir invalidates list cache", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "post", "/mkdir");
    const res = mockRes();

    mockClient.files.createDirectory.mockResolvedValue(undefined);

    await handler(
      mockReq("uploads", {
        body: { path: "/Volumes/catalog/schema/uploads/newdir" },
      }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(mockCacheInstance.generateKey).toHaveBeenCalled();
    expect(mockCacheInstance.delete).toHaveBeenCalled();
  });

  test("mkdir without path returns 400", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "post", "/mkdir");
    const res = mockRes();

    await handler(mockReq("uploads", { body: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "path is required" }),
    );
  });

  test("mkdir that throws ApiError 409 is handled via execute", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "post", "/mkdir");
    const res = mockRes();

    mockClient.files.createDirectory.mockRejectedValue(
      new MockApiError("Conflict", 409),
    );

    await handler(
      mockReq("uploads", {
        body: { path: "/Volumes/catalog/schema/uploads/existing" },
      }),
      res,
    );

    // SDK errors go through execute() -> _sendStatusError with status 409
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
