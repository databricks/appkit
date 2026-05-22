import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
  makeStreamResponse,
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

describe("FilesPlugin download endpoint Content-Disposition", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  beforeEach(async () => {
    serviceContextMock = await setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  test("download sets Content-Disposition: attachment with filename", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    mockClient.files.download.mockResolvedValue(
      makeStreamResponse("file data"),
    );

    await handler(
      mockReq("uploads", {
        query: { path: "/Volumes/catalog/schema/uploads/report.pdf" },
      }),
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="report.pdf"',
    );
  });

  test("download sanitizes filename with special characters", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    mockClient.files.download.mockResolvedValue(makeStreamResponse("data"));

    await handler(
      mockReq("uploads", {
        query: { path: '/Volumes/catalog/schema/uploads/my "file".txt' },
      }),
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="my \\"file\\".txt"',
    );
  });

  test("download always sets Content-Disposition even for safe types", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    mockClient.files.download.mockResolvedValue(makeStreamResponse("{}"));

    await handler(
      mockReq("uploads", {
        query: { path: "/Volumes/catalog/schema/uploads/data.json" },
      }),
      res,
    );

    // Download mode always forces attachment, even for safe types
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'attachment; filename="data.json"',
    );
  });

  test("download with missing path returns 400", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    await handler(mockReq("uploads", { query: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "path is required",
        plugin: "files",
      }),
    );
  });

  test("download with response having no contents calls res.end()", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    // Response with no contents field (empty file)
    mockClient.files.download.mockResolvedValue({});

    await handler(
      mockReq("uploads", {
        query: { path: "/Volumes/catalog/schema/uploads/empty.txt" },
      }),
      res,
    );

    expect(res.end).toHaveBeenCalled();
  });
});
