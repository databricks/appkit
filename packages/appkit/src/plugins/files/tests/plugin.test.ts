import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { FilesPlugin, files } from "../plugin";

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
    generateKey: vi.fn(),
  };

  return { mockFilesApi, mockClient, MockApiError, mockCacheInstance };
});

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => mockClient),
  ApiError: MockApiError,
}));

vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => mockClient),
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test('plugin name is "files"', () => {
    const pluginData = files({ defaultVolume: "/Volumes/test" });
    expect(pluginData.name).toBe("files");
  });

  test("plugin instance has correct name", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    expect(plugin.name).toBe("files");
  });

  test("exports() returns all expected methods", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const exported = plugin.exports();

    expect(exported).toHaveProperty("list");
    expect(exported).toHaveProperty("read");
    expect(exported).toHaveProperty("download");
    expect(exported).toHaveProperty("exists");
    expect(exported).toHaveProperty("metadata");
    expect(exported).toHaveProperty("upload");
    expect(exported).toHaveProperty("createDirectory");
    expect(exported).toHaveProperty("delete");
    expect(exported).toHaveProperty("preview");

    for (const value of Object.values(exported)) {
      expect(typeof value).toBe("function");
    }
  });

  test("injectRoutes registers GET and POST routes", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const mockRouter = {
      use: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    } as any;

    plugin.injectRoutes(mockRouter);

    // 8 GET routes
    // root, list, read, download, raw, exists, metadata, preview
    expect(mockRouter.get).toHaveBeenCalledTimes(8);
    // 3 POST routes:
    // upload, mkdir, delete
    expect(mockRouter.post).toHaveBeenCalledTimes(3);
    expect(mockRouter.put).not.toHaveBeenCalled();
    expect(mockRouter.patch).not.toHaveBeenCalled();
  });

  test("shutdown() calls streamManager.abortAll()", async () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

    await plugin.shutdown();

    expect(abortAllSpy).toHaveBeenCalled();
  });

  describe("Upload Size Validation", () => {
    function getUploadHandler(plugin: FilesPlugin) {
      const mockRouter = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        patch: vi.fn(),
      } as any;

      plugin.injectRoutes(mockRouter);

      // Find the upload handler — the POST call with path "/upload"
      const uploadCall = mockRouter.post.mock.calls.find(
        (call: unknown[]) => call[0] === "/upload",
      );
      // The handler is the last argument (after path and optional middlewares)
      return uploadCall[uploadCall.length - 1] as (
        req: any,
        res: any,
      ) => Promise<void>;
    }

    function mockRes() {
      const res: any = {};
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      return res;
    }

    test("rejects upload with content-length over default limit (413)", async () => {
      const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      await handler(
        {
          query: { path: "/Volumes/test/large.bin" },
          headers: { "content-length": String(6 * 1024 * 1024 * 1024) },
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("exceeds maximum allowed size"),
          plugin: "files",
        }),
      );
    });

    test("rejects upload with content-length over custom limit (413)", async () => {
      const plugin = new FilesPlugin({
        defaultVolume: "/Volumes/test",
        maxUploadSize: 1024, // 1 KB
      });
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      await handler(
        {
          query: { path: "/Volumes/test/file.bin" },
          headers: { "content-length": "2048" },
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("2048 bytes"),
          plugin: "files",
        }),
      );
    });

    test("allows upload with content-length at exactly the limit", async () => {
      const plugin = new FilesPlugin({
        defaultVolume: "/Volumes/test",
        maxUploadSize: 1024,
      });
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      // Content-length === maxUploadSize should NOT trigger 413.
      // The handler will fail later (mock req isn't a real Readable stream),
      // but it must pass the size check first.
      let caughtError: unknown;
      try {
        await handler(
          {
            query: { path: "/Volumes/test/file.bin" },
            headers: { "content-length": "1024" },
          },
          res,
        );
      } catch (err) {
        caughtError = err;
      }

      // Verify the error is from Readable.toWeb (past the size check)
      expect(caughtError).toBeDefined();
      expect((caughtError as Error).message).toMatch(/stream\.Readable/i);

      // Should NOT have been called with 413
      const statusCalls = res.status.mock.calls;
      const has413 = statusCalls.some((call: number[]) => call[0] === 413);
      expect(has413).toBe(false);
    });

    test("allows upload when content-length header is missing", async () => {
      const plugin = new FilesPlugin({
        defaultVolume: "/Volumes/test",
        maxUploadSize: 1024,
      });
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      // Without content-length, the size check is skipped.
      // Handler will fail later on Readable.toWeb(req).
      let caughtError: unknown;
      try {
        await handler(
          {
            query: { path: "/Volumes/test/file.bin" },
            headers: {},
          },
          res,
        );
      } catch (err) {
        caughtError = err;
      }

      // Verify the error is from Readable.toWeb (past the size check)
      expect(caughtError).toBeDefined();
      expect((caughtError as Error).message).toMatch(/stream\.Readable/i);

      // Should NOT have been called with 413
      const statusCalls = res.status.mock.calls;
      const has413 = statusCalls.some((call: number[]) => call[0] === 413);
      expect(has413).toBe(false);
    });
  });
});
