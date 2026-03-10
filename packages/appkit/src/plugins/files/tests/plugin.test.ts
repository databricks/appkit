import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AuthenticationError } from "../../../errors";
import { ResourceType } from "../../../registry";
import {
  FILES_DOWNLOAD_DEFAULTS,
  FILES_READ_DEFAULTS,
  FILES_WRITE_DEFAULTS,
} from "../defaults";
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

const VOLUMES_CONFIG = {
  volumes: {
    uploads: { maxUploadSize: 100_000_000 },
    exports: {},
  },
};

describe("FilesPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    ServiceContext.reset();
    process.env.DATABRICKS_VOLUME_UPLOADS = "/Volumes/catalog/schema/uploads";
    process.env.DATABRICKS_VOLUME_EXPORTS = "/Volumes/catalog/schema/exports";
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    delete process.env.DATABRICKS_VOLUME_UPLOADS;
    delete process.env.DATABRICKS_VOLUME_EXPORTS;
  });

  test('plugin name is "files"', () => {
    const pluginData = files(VOLUMES_CONFIG);
    expect(pluginData.name).toBe("files");
  });

  test("plugin instance has correct name", () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    expect(plugin.name).toBe("files");
  });

  describe("discoverVolumes", () => {
    test("discovers volumes from DATABRICKS_VOLUME_* env vars", () => {
      const volumes = FilesPlugin.discoverVolumes({});
      expect(volumes).toHaveProperty("uploads");
      expect(volumes).toHaveProperty("exports");
      expect(volumes.uploads).toEqual({});
      expect(volumes.exports).toEqual({});
    });

    test("merges with explicit config, explicit wins", () => {
      const volumes = FilesPlugin.discoverVolumes({
        volumes: {
          uploads: { maxUploadSize: 42 },
        },
      });
      expect(volumes.uploads).toEqual({ maxUploadSize: 42 });
      expect(volumes.exports).toEqual({});
    });

    test("skips bare DATABRICKS_VOLUME_ prefix (no suffix)", () => {
      process.env.DATABRICKS_VOLUME_ = "/Volumes/bare";
      try {
        const volumes = FilesPlugin.discoverVolumes({});
        expect(Object.keys(volumes)).not.toContain("");
      } finally {
        delete process.env.DATABRICKS_VOLUME_;
      }
    });

    test("skips empty env var values", () => {
      process.env.DATABRICKS_VOLUME_EMPTY = "";
      try {
        const volumes = FilesPlugin.discoverVolumes({});
        expect(volumes).not.toHaveProperty("empty");
      } finally {
        delete process.env.DATABRICKS_VOLUME_EMPTY;
      }
    });

    test("lowercases env var suffix", () => {
      process.env.DATABRICKS_VOLUME_MY_DATA = "/Volumes/catalog/schema/data";
      try {
        const volumes = FilesPlugin.discoverVolumes({});
        expect(volumes).toHaveProperty("my_data");
      } finally {
        delete process.env.DATABRICKS_VOLUME_MY_DATA;
      }
    });

    test("returns only explicit volumes when no env vars match", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;
      const volumes = FilesPlugin.discoverVolumes({
        volumes: { custom: { maxUploadSize: 10 } },
      });
      expect(Object.keys(volumes)).toEqual(["custom"]);
    });
  });

  describe("getResourceRequirements", () => {
    test("generates one resource per volume key", () => {
      const requirements = FilesPlugin.getResourceRequirements(VOLUMES_CONFIG);
      expect(requirements).toHaveLength(2);

      const uploadsReq = requirements.find(
        (r) => r.resourceKey === "volume-uploads",
      );
      expect(uploadsReq).toBeDefined();
      expect(uploadsReq?.type).toBe(ResourceType.VOLUME);
      expect(uploadsReq?.permission).toBe("WRITE_VOLUME");
      expect(uploadsReq?.fields.path.env).toBe("DATABRICKS_VOLUME_UPLOADS");
      expect(uploadsReq?.required).toBe(true);

      const exportsReq = requirements.find(
        (r) => r.resourceKey === "volume-exports",
      );
      expect(exportsReq).toBeDefined();
      expect(exportsReq?.fields.path.env).toBe("DATABRICKS_VOLUME_EXPORTS");
    });

    test("returns empty array when no volumes configured and no env vars", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;
      const requirements = FilesPlugin.getResourceRequirements({
        volumes: {},
      });
      expect(requirements).toHaveLength(0);
    });

    test("auto-discovers volumes from env vars with empty config", () => {
      const requirements = FilesPlugin.getResourceRequirements({});
      expect(requirements).toHaveLength(2);
      expect(requirements.map((r) => r.resourceKey).sort()).toEqual([
        "volume-exports",
        "volume-uploads",
      ]);
    });
  });

  describe("exports()", () => {
    test("returns a callable function with a .volume alias", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const exported = plugin.exports();

      expect(typeof exported).toBe("function");
      expect(typeof exported.volume).toBe("function");
    });

    test("returns volume handle with asUser and direct VolumeAPI methods", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const exported = plugin.exports();

      for (const key of ["uploads", "exports"]) {
        const handle = exported(key);
        expect(typeof handle.asUser).toBe("function");
        expect(typeof handle.list).toBe("function");
        expect(typeof handle.read).toBe("function");
        expect(typeof handle.upload).toBe("function");
      }
    });

    test(".volume() returns the same shape as the callable", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const exported = plugin.exports();

      const direct = exported("uploads");
      const viaVolume = exported.volume("uploads");

      expect(Object.keys(direct).sort()).toEqual(Object.keys(viaVolume).sort());
    });

    test("throws for unknown volume key", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const exported = plugin.exports();

      expect(() => exported("unknown")).toThrow(/Unknown volume "unknown"/);
      expect(() => exported.volume("unknown")).toThrow(
        /Unknown volume "unknown"/,
      );
    });
  });

  describe("OBO and service principal access", () => {
    const volumeMethods = [
      "list",
      "read",
      "download",
      "exists",
      "metadata",
      "upload",
      "createDirectory",
      "delete",
      "preview",
    ];

    test("volume handle exposes asUser and all VolumeAPI methods", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handle = plugin.exports()("uploads");

      expect(typeof handle.asUser).toBe("function");
      for (const method of volumeMethods) {
        expect(typeof (handle as any)[method]).toBe("function");
      }
    });

    test("asUser throws AuthenticationError without token in production", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        const plugin = new FilesPlugin(VOLUMES_CONFIG);
        const handle = plugin.exports()("uploads");
        const mockReq = { header: () => undefined } as any;

        expect(() => handle.asUser(mockReq)).toThrow(AuthenticationError);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("asUser in dev mode returns VolumeAPI with all 9 methods", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      try {
        const plugin = new FilesPlugin(VOLUMES_CONFIG);
        const handle = plugin.exports()("uploads");
        const mockReq = { header: () => undefined } as any;
        const api = handle.asUser(mockReq);

        for (const method of volumeMethods) {
          expect(typeof (api as any)[method]).toBe("function");
        }
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("direct methods on handle throw without user context (OBO enforced)", async () => {
      const { isInUserContext } = await import("../../../context");
      (isInUserContext as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handle = plugin.exports()("uploads");

      // Direct call without user context should throw synchronously
      expect(() => handle.list()).toThrow(
        'app.files("uploads").list() called without user context (service principal). Use OBO instead: app.files("uploads").asUser(req).list()',
      );
    });
  });

  test("injectRoutes registers volume-scoped routes", () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const mockRouter = {
      use: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    } as any;

    plugin.injectRoutes(mockRouter);

    // 1 GET /volumes + 7 GET /:volumeKey/* routes
    // (list, read, download, raw, exists, metadata, preview)
    expect(mockRouter.get).toHaveBeenCalledTimes(8);
    // 2 POST /:volumeKey/* routes (upload, mkdir)
    expect(mockRouter.post).toHaveBeenCalledTimes(2);
    // 1 DELETE /:volumeKey route
    expect(mockRouter.delete).toHaveBeenCalledTimes(1);
    expect(mockRouter.put).not.toHaveBeenCalled();
    expect(mockRouter.patch).not.toHaveBeenCalled();
  });

  test("shutdown() calls streamManager.abortAll()", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

    await plugin.shutdown();

    expect(abortAllSpy).toHaveBeenCalled();
  });

  describe("Volume route validation", () => {
    function getRouteHandler(
      plugin: FilesPlugin,
      method: "get" | "post",
      pathSuffix: string,
    ) {
      const mockRouter = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        patch: vi.fn(),
      } as any;

      plugin.injectRoutes(mockRouter);

      const call = mockRouter[method].mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).endsWith(pathSuffix),
      );
      return call[call.length - 1] as (req: any, res: any) => Promise<void>;
    }

    function mockRes() {
      const res: any = {};
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      return res;
    }

    test("returns 404 for unknown volume key", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      await handler({ params: { volumeKey: "unknown" }, query: {} }, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Unknown volume "unknown"'),
        }),
      );
    });

    test("/volumes returns configured volume keys", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/volumes");
      const res = mockRes();

      await handler({ params: {}, query: {} }, res);

      expect(res.json).toHaveBeenCalledWith({
        volumes: ["uploads", "exports"],
      });
    });
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

      const uploadCall = mockRouter.post.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          (call[0] as string).endsWith("/upload"),
      );
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

    test("rejects upload with content-length over per-volume limit (413)", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      // uploads has maxUploadSize: 100_000_000
      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/large.bin" },
          headers: { "content-length": String(200_000_000) },
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

    test("rejects upload with content-length over default limit (413)", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      // exports has no maxUploadSize, uses default 5GB
      await handler(
        {
          params: { volumeKey: "exports" },
          query: { path: "/large.bin" },
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

    test("allows upload with content-length at exactly the limit", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/file.bin" },
          headers: { "content-length": String(100_000_000) },
        },
        res,
      );

      const statusCalls = res.status.mock.calls;
      const has413 = statusCalls.some((call: number[]) => call[0] === 413);
      expect(has413).toBe(false);

      const has500 = statusCalls.some((call: number[]) => call[0] === 500);
      expect(has500).toBe(true);
    });

    test("allows upload when content-length header is missing", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getUploadHandler(plugin);
      const res = mockRes();

      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/file.bin" },
          headers: {},
        },
        res,
      );

      const statusCalls = res.status.mock.calls;
      const has413 = statusCalls.some((call: number[]) => call[0] === 413);
      expect(has413).toBe(false);

      const has500 = statusCalls.some((call: number[]) => call[0] === 500);
      expect(has500).toBe(true);
    });
  });

  describe("auto-discovery integration", () => {
    test("files() with no volumes config discovers from env vars", () => {
      const plugin = new FilesPlugin({});
      const exported = plugin.exports();
      // Discovered volumes are accessible via the callable
      expect(() => exported("uploads")).not.toThrow();
      expect(() => exported("exports")).not.toThrow();
    });

    test("files() with no config and no env vars creates no volumes", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;
      const plugin = new FilesPlugin({});
      const exported = plugin.exports();
      expect(() => exported("uploads")).toThrow(/Unknown volume/);
    });
  });

  describe("Timeout behavior", () => {
    function getRouteHandlerForTimeout(
      plugin: FilesPlugin,
      method: "get" | "post" | "delete",
      pathSuffix: string,
    ) {
      const mockRouter = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        patch: vi.fn(),
      } as any;

      plugin.injectRoutes(mockRouter);

      const call = mockRouter[method].mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).endsWith(pathSuffix),
      );
      return call[call.length - 1] as (req: any, res: any) => Promise<void>;
    }

    function mockRes() {
      const res: any = {
        headersSent: false,
      };
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.type = vi.fn().mockReturnValue(res);
      res.send = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      res.destroy = vi.fn();
      res.end = vi.fn();
      res.on = vi.fn().mockReturnValue(res);
      res.pipe = vi.fn().mockReturnValue(res);
      return res;
    }

    function mockReq(volumeKey: string, overrides: Record<string, any> = {}) {
      const headers: Record<string, string> = {
        "x-forwarded-access-token": "test-token",
        "x-forwarded-user": "test-user",
        ...(overrides.headers ?? {}),
      };
      return {
        params: { volumeKey },
        query: {},
        ...overrides,
        headers,
        header: (name: string) => headers[name.toLowerCase()],
      };
    }

    /**
     * Creates a mock that resolves after a signal-based abort.
     * The returned promise rejects with an abort error when the
     * interceptor's timeout signal fires, simulating a well-behaved
     * SDK call that respects AbortSignal.
     */
    function hangingWithAbort(): {
      promise: Promise<never>;
      capturedReject: (reason: unknown) => void;
    } {
      let capturedReject!: (reason: unknown) => void;
      const promise = new Promise<never>((_resolve, reject) => {
        capturedReject = reject;
      });
      return { promise, capturedReject };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("read-tier: list succeeds when operation completes within timeout", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "file.txt", path: "/file.txt", is_directory: false };
        },
      );

      const handlerPromise = handler(mockReq("uploads"), res);

      await vi.advanceTimersByTimeAsync(100);
      await handlerPromise;

      expect(res.json).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "file.txt" })]),
      );
      expect(res.status).not.toHaveBeenCalled();
    });

    test("read-tier: list returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/list");
      const res = mockRes();

      // Simulate an SDK call that rejects (e.g. network error).
      // Returns an async iterable whose first iteration throws.
      mockClient.files.listDirectoryContents.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("network failure")),
        }),
      });

      const handlerPromise = handler(mockReq("uploads"), res);
      // Advance past retry delays (3 attempts: 1s + 2s backoff)
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "List failed",
          plugin: "files",
        }),
      );
    });

    test("read-tier: read returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/read");
      const res = mockRes();

      mockClient.files.download.mockRejectedValue(new Error("network failure"));

      const handlerPromise = handler(
        mockReq("uploads", { query: { path: "test.txt" } }),
        res,
      );

      // Advance past retry delays
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Read failed" }),
      );
    });

    test("read-tier: exists returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/exists");
      const res = mockRes();

      mockClient.files.getMetadata.mockRejectedValue(
        new Error("network failure"),
      );

      const handlerPromise = handler(
        mockReq("uploads", { query: { path: "test.txt" } }),
        res,
      );

      // Advance past retry delays: attempt 1 fails, wait 1s, attempt 2 fails, wait 2s, attempt 3 fails
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Exists check failed" }),
      );
    });

    test("read-tier: metadata returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/metadata");
      const res = mockRes();

      mockClient.files.getMetadata.mockRejectedValue(
        new Error("network failure"),
      );

      const handlerPromise = handler(
        mockReq("uploads", { query: { path: "test.txt" } }),
        res,
      );

      // Advance past retry delays
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Metadata fetch failed" }),
      );
    });

    test("download-tier: download returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/download");
      const res = mockRes();

      mockClient.files.download.mockRejectedValue(new Error("network failure"));

      const handlerPromise = handler(
        mockReq("uploads", { query: { path: "big.bin" } }),
        res,
      );

      // Advance past retry delays
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Download failed" }),
      );
    });

    test("write-tier: mkdir returns 500 when SDK call rejects", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "post", "/mkdir");
      const res = mockRes();

      mockClient.files.createDirectory.mockRejectedValue(
        new Error("network failure"),
      );

      const handlerPromise = handler(
        mockReq("uploads", { body: { path: "new-dir" } }),
        res,
      );

      await vi.advanceTimersByTimeAsync(100);
      await handlerPromise;

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Create directory failed" }),
      );
    });

    test("write-tier: inflightWrites decrements after error", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "post", "/mkdir");
      const res = mockRes();

      mockClient.files.createDirectory.mockRejectedValue(
        new Error("network failure"),
      );

      expect((plugin as any).inflightWrites).toBe(0);

      const handlerPromise = handler(
        mockReq("uploads", { body: { path: "dir" } }),
        res,
      );

      await vi.advanceTimersByTimeAsync(100);
      await handlerPromise;

      expect((plugin as any).inflightWrites).toBe(0);
    });

    test("error response does not leak internal details", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject(new Error("internal: secret connection string xyz")),
        }),
      });

      const handlerPromise = handler(mockReq("uploads"), res);
      // Advance past retry delays
      await vi.advanceTimersByTimeAsync(4_000);
      await handlerPromise;

      const errorBody = res.json.mock.calls[0][0];
      expect(errorBody.error).toBe("List failed");
      expect(errorBody.error).not.toContain("secret");
      expect(errorBody.error).not.toContain("internal");
    });

    test("timeout interceptor sets abort signal on context but callbacks ignore it", async () => {
      // This test documents a known gap: the TimeoutInterceptor sets
      // context.signal, but the files plugin callbacks don't consume it.
      // The timeout only works if the underlying SDK call respects the signal
      // or rejects on its own.
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandlerForTimeout(plugin, "get", "/list");
      const res = mockRes();

      let signalWasAborted = false;
      const { promise, capturedReject } = hangingWithAbort();

      mockClient.files.listDirectoryContents.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            // Simulate: we set up a timeout that rejects the hanging promise,
            // proving the timeout WOULD fire if the SDK respected the signal.
            const timeoutId = setTimeout(() => {
              signalWasAborted = true;
              capturedReject(new Error("Operation timed out after 30000 ms"));
            }, 30_000);

            return promise.finally(() => clearTimeout(timeoutId));
          },
        }),
      });

      const handlerPromise = handler(mockReq("uploads"), res);

      // Advance past read-tier timeout (30s)
      await vi.advanceTimersByTimeAsync(31_000);
      await handlerPromise;

      expect(signalWasAborted).toBe(true);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "List failed" }),
      );
    });

    test("timeout defaults: read-tier uses 30s", () => {
      expect(FILES_READ_DEFAULTS.timeout).toBe(30_000);
    });

    test("timeout defaults: download-tier uses 30s", () => {
      expect(FILES_DOWNLOAD_DEFAULTS.timeout).toBe(30_000);
    });

    test("timeout defaults: write-tier uses 600s", () => {
      expect(FILES_WRITE_DEFAULTS.timeout).toBe(600_000);
    });
  });

  describe("Upload Stream Size Limiter", () => {
    test("stream under limit passes through all chunks", async () => {
      const maxSize = 100;
      let bytesReceived = 0;

      const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesReceived += chunk.byteLength;
          if (bytesReceived > maxSize) {
            controller.error(
              new Error(
                `Upload stream exceeds maximum allowed size (${maxSize} bytes)`,
              ),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      });

      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(50));
          controller.enqueue(new Uint8Array(30));
          controller.close();
        },
      });

      const reader = input.pipeThrough(limiter).getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].byteLength).toBe(50);
      expect(chunks[1].byteLength).toBe(30);
    });

    test("stream exceeding limit errors with size message", async () => {
      const maxSize = 10;
      let bytesReceived = 0;

      const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesReceived += chunk.byteLength;
          if (bytesReceived > maxSize) {
            controller.error(
              new Error(
                `Upload stream exceeds maximum allowed size (${maxSize} bytes)`,
              ),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      });

      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(15)); // 15 > 10
          controller.close();
        },
      });

      const reader = input.pipeThrough(limiter).getReader();
      await expect(reader.read()).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });

    test("stream errors mid-transfer when cumulative size exceeds limit", async () => {
      const maxSize = 20;
      let bytesReceived = 0;

      const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesReceived += chunk.byteLength;
          if (bytesReceived > maxSize) {
            controller.error(
              new Error(
                `Upload stream exceeds maximum allowed size (${maxSize} bytes)`,
              ),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      });

      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10)); // 10 — OK
          controller.enqueue(new Uint8Array(10)); // 20 — OK
          controller.enqueue(new Uint8Array(5)); // 25 > 20 — FAIL
          controller.close();
        },
      });

      const reader = input.pipeThrough(limiter).getReader();
      const chunk1 = await reader.read();
      expect(chunk1.done).toBe(false);
      expect(chunk1.value?.byteLength).toBe(10);

      const chunk2 = await reader.read();
      expect(chunk2.done).toBe(false);
      expect(chunk2.value?.byteLength).toBe(10);

      await expect(reader.read()).rejects.toThrow(
        /exceeds maximum allowed size/,
      );
    });
  });
});
