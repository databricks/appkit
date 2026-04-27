import { Readable } from "node:stream";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { AuthenticationError } from "../../../errors";
import { ResourceType } from "../../../registry";
import {
  FILES_DOWNLOAD_DEFAULTS,
  FILES_READ_DEFAULTS,
  FILES_WRITE_DEFAULTS,
} from "../defaults";
import { FilesPlugin, files } from "../plugin";
import { PolicyDeniedError, policy } from "../policy";

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
    getCurrentUserId: vi.fn(() => "test-service-principal"),
  };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
    getInstance: vi.fn(async () => mockCacheInstance),
  },
}));

const VOLUMES_CONFIG = {
  volumes: {
    uploads: { maxUploadSize: 100_000_000, policy: policy.allowAll() },
    exports: { policy: policy.allowAll() },
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

  describe("getAgentTools / executeAgentTool", () => {
    test("produces independent tool entries per volume", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const tools = plugin.getAgentTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain("uploads.list");
      expect(names).toContain("uploads.read");
      expect(names).toContain("uploads.exists");
      expect(names).toContain("uploads.metadata");
      expect(names).toContain("uploads.upload");
      expect(names).toContain("uploads.delete");

      expect(names).toContain("exports.list");
      expect(names).toContain("exports.read");
      expect(names).toContain("exports.delete");

      expect(tools).toHaveLength(12);
    });

    test("dispatches to the correct volume API based on the tool name", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const asyncIterable = (items: { path: string }[]) => ({
        [Symbol.asyncIterator]: async function* () {
          for (const item of items) yield item;
        },
      });
      mockClient.files.listDirectoryContents.mockReturnValueOnce(
        asyncIterable([{ path: "uploads-file" }]),
      );
      mockClient.files.listDirectoryContents.mockReturnValueOnce(
        asyncIterable([{ path: "exports-file" }]),
      );

      const uploadsResult = (await plugin.executeAgentTool(
        "uploads.list",
        {},
      )) as { path: string }[];
      const exportsResult = (await plugin.executeAgentTool(
        "exports.list",
        {},
      )) as { path: string }[];

      expect(uploadsResult[0].path).toBe("uploads-file");
      expect(exportsResult[0].path).toBe("exports-file");
    });

    test("returns LLM-friendly error string for invalid tool args", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const result = await plugin.executeAgentTool("uploads.read", {});
      expect(typeof result).toBe("string");
      expect(result).toContain("Invalid arguments for uploads.read");
      expect(result).toContain("path");
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

  describe("Service principal access", () => {
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

    test("asUser without user header in production → throws AuthenticationError", () => {
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

    test("asUser without user header in development → falls back to SP identity", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        const plugin = new FilesPlugin(VOLUMES_CONFIG);
        const handle = plugin.exports()("uploads");
        const mockReq = { header: () => undefined } as any;

        // Does not throw; returns a VolumeAPI that will run the policy with
        // { isServicePrincipal: true } (matching the HTTP-path collapsed semantic).
        const api = handle.asUser(mockReq);
        expect(typeof api.list).toBe("function");
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("direct methods on handle work as service principal", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handle = plugin.exports()("uploads");

      // Direct call executes as service principal (returns a promise, does not throw)
      expect(typeof handle.list).toBe("function");
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
      const headers: Record<string, string> = {
        "content-length": String(200_000_000),
        "x-forwarded-user": "test-user",
      };
      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/large.bin" },
          headers,
          header: (name: string) => headers[name.toLowerCase()],
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
      const headers: Record<string, string> = {
        "content-length": String(6 * 1024 * 1024 * 1024),
        "x-forwarded-user": "test-user",
      };
      await handler(
        {
          params: { volumeKey: "exports" },
          query: { path: "/large.bin" },
          headers,
          header: (name: string) => headers[name.toLowerCase()],
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

      const headers: Record<string, string> = {
        "content-length": String(100_000_000),
        "x-forwarded-user": "test-user",
      };
      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/file.bin" },
          headers,
          header: (name: string) => headers[name.toLowerCase()],
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

      const headers: Record<string, string> = {
        "x-forwarded-user": "test-user",
      };
      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/file.bin" },
          headers,
          header: (name: string) => headers[name.toLowerCase()],
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

      // Flush microtasks (policy check) before advancing timers
      await vi.advanceTimersByTimeAsync(0);
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
          error: "Internal Server Error",
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
        expect.objectContaining({ error: "Internal Server Error" }),
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
        expect.objectContaining({ error: "Internal Server Error" }),
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
        expect.objectContaining({ error: "Internal Server Error" }),
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
        expect.objectContaining({ error: "Internal Server Error" }),
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
        expect.objectContaining({ error: "Internal Server Error" }),
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
      expect(errorBody.error).toBe("Internal Server Error");
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

      // Flush microtasks (policy check) before advancing timers
      await vi.advanceTimersByTimeAsync(0);
      // Advance past read-tier timeout (30s)
      await vi.advanceTimersByTimeAsync(31_000);
      await handlerPromise;

      expect(signalWasAborted).toBe(true);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Internal Server Error" }),
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

  describe("Policy enforcement", () => {
    const POLICY_CONFIG = {
      volumes: {
        public: { policy: policy.publicRead() },
        locked: { policy: policy.denyAll() },
        open: { policy: policy.allowAll() },
        writeonly: { policy: policy.not(policy.publicRead()) },
        uploads: {},
        exports: {},
      },
    };

    function getRouteHandler(
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
      const res: any = { headersSent: false };
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.type = vi.fn().mockReturnValue(res);
      res.send = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      res.end = vi.fn();
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

    beforeEach(() => {
      process.env.DATABRICKS_VOLUME_PUBLIC = "/Volumes/c/s/public";
      process.env.DATABRICKS_VOLUME_LOCKED = "/Volumes/c/s/locked";
      process.env.DATABRICKS_VOLUME_OPEN = "/Volumes/c/s/open";
      process.env.DATABRICKS_VOLUME_WRITEONLY = "/Volumes/c/s/writeonly";
    });

    afterEach(() => {
      delete process.env.DATABRICKS_VOLUME_PUBLIC;
      delete process.env.DATABRICKS_VOLUME_LOCKED;
      delete process.env.DATABRICKS_VOLUME_OPEN;
      delete process.env.DATABRICKS_VOLUME_WRITEONLY;
    });

    test("header-less HTTP + default publicRead() + read action → 200 with SP user", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const spyConfig = {
        volumes: {
          spied: { policy: policySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_SPIED = "/Volumes/c/s/spied";

      try {
        const plugin = new FilesPlugin(spyConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        mockClient.files.listDirectoryContents.mockImplementation(
          async function* () {
            yield { name: "h.txt", path: "/h.txt", is_directory: false };
          },
        );

        const noUserHeaders: Record<string, string> = {};
        await handler(
          {
            params: { volumeKey: "spied" },
            query: {},
            headers: noUserHeaders,
            header: (name: string) => noUserHeaders[name.toLowerCase()],
          },
          res,
        );

        const statusCodes = (res.status.mock.calls as number[][]).map(
          (c) => c[0],
        );
        expect(statusCodes).not.toContain(401);
        expect(statusCodes).not.toContain(403);
        expect(policySpy).toHaveBeenCalledWith(
          "list",
          expect.objectContaining({ volume: "spied" }),
          expect.objectContaining({
            id: "test-service-principal",
            isServicePrincipal: true,
          }),
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_SPIED;
      }
    });

    test("header-less HTTP + default publicRead() + write action → 403 with SP user", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      const noUserHeaders: Record<string, string> = {
        "content-length": "100",
      };
      await handler(
        {
          params: { volumeKey: "uploads" },
          query: { path: "/test.bin" },
          headers: noUserHeaders,
          header: (name: string) => noUserHeaders[name.toLowerCase()],
        },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("header-less HTTP + denyAll() → 403 with SP user observed by policy", async () => {
      const policySpy = vi.fn(policy.denyAll());
      const spyConfig = {
        volumes: {
          denied: { policy: policySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_DENIED = "/Volumes/c/s/denied";

      try {
        const plugin = new FilesPlugin(spyConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        const noUserHeaders: Record<string, string> = {};
        await handler(
          {
            params: { volumeKey: "denied" },
            query: {},
            headers: noUserHeaders,
            header: (name: string) => noUserHeaders[name.toLowerCase()],
          },
          res,
        );

        expect(res.status).toHaveBeenCalledWith(403);
        expect(policySpy).toHaveBeenCalledWith(
          "list",
          expect.objectContaining({ volume: "denied" }),
          expect.objectContaining({ isServicePrincipal: true }),
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_DENIED;
      }
    });

    test("header-less HTTP request → policy spy observes { isServicePrincipal: true } and decision is honored", async () => {
      const allowSpy = vi.fn().mockResolvedValue(true);
      const allowConfig = {
        volumes: {
          gated: { policy: allowSpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_GATED = "/Volumes/c/s/gated";

      try {
        const plugin = new FilesPlugin(allowConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        mockClient.files.listDirectoryContents.mockImplementation(
          async function* () {
            yield { name: "g.txt", path: "/g.txt", is_directory: false };
          },
        );

        const noUserHeaders: Record<string, string> = {};
        await handler(
          {
            params: { volumeKey: "gated" },
            query: {},
            headers: noUserHeaders,
            header: (name: string) => noUserHeaders[name.toLowerCase()],
          },
          res,
        );

        expect(allowSpy).toHaveBeenCalledTimes(1);
        const userArg = allowSpy.mock.calls[0][2];
        expect(userArg.isServicePrincipal).toBe(true);
        expect(userArg.id).toBe("test-service-principal");

        const statusCodes = (res.status.mock.calls as number[][]).map(
          (c) => c[0],
        );
        expect(statusCodes).not.toContain(401);
        expect(statusCodes).not.toContain(403);
      } finally {
        delete process.env.DATABRICKS_VOLUME_GATED;
      }
    });

    test("header-less HTTP request + policy returns false → 403 (decision honored)", async () => {
      const denySpy = vi.fn().mockResolvedValue(false);
      const denyConfig = {
        volumes: {
          gated: { policy: denySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_GATED = "/Volumes/c/s/gated";

      try {
        const plugin = new FilesPlugin(denyConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        const noUserHeaders: Record<string, string> = {};
        await handler(
          {
            params: { volumeKey: "gated" },
            query: {},
            headers: noUserHeaders,
            header: (name: string) => noUserHeaders[name.toLowerCase()],
          },
          res,
        );

        expect(denySpy).toHaveBeenCalledTimes(1);
        const userArg = denySpy.mock.calls[0][2];
        expect(userArg.isServicePrincipal).toBe(true);
        expect(res.status).toHaveBeenCalledWith(403);
      } finally {
        delete process.env.DATABRICKS_VOLUME_GATED;
      }
    });

    test("policy volume + policy returns false → 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      await handler(mockReq("locked"), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("policy volume + policy returns true → 200, runs as SP", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "a.txt", path: "/a.txt", is_directory: false };
        },
      );

      await handler(mockReq("public", { query: {} }), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "a.txt" })]),
      );
      // Should NOT have received a 401 or 403
      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
    });

    test("policy volume + async policy → works", async () => {
      const asyncConfig = {
        volumes: {
          async_vol: {
            policy: async () => true,
          },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_ASYNC_VOL = "/Volumes/c/s/async";

      try {
        const plugin = new FilesPlugin(asyncConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        mockClient.files.listDirectoryContents.mockImplementation(
          async function* () {
            yield { name: "b.txt", path: "/b.txt", is_directory: false };
          },
        );

        await handler(mockReq("async_vol"), res);

        expect(res.json).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ name: "b.txt" })]),
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_ASYNC_VOL;
      }
    });

    test("default publicRead() volume → reads succeed", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "c.txt", path: "/c.txt", is_directory: false };
        },
      );

      await handler(mockReq("uploads"), res);

      // Should succeed (reads allowed by publicRead default)
      expect(res.json).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "c.txt" })]),
      );
    });

    test("default publicRead() volume → writes denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/mkdir");
      const res = mockRes();

      await handler(
        mockReq("uploads", {
          body: { path: "/newdir" },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("upload with policy → policy receives size in resource", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const sizeConfig = {
        volumes: {
          sized: { policy: policySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_SIZED = "/Volumes/c/s/sized";

      try {
        const plugin = new FilesPlugin(sizeConfig);
        const handler = getRouteHandler(plugin, "post", "/upload");
        const res = mockRes();

        await handler(
          mockReq("sized", {
            query: { path: "/test.bin" },
            headers: {
              "content-length": "12345",
              "x-forwarded-user": "test-user",
              "x-forwarded-access-token": "test-token",
            },
          }),
          res,
        );

        expect(policySpy).toHaveBeenCalledWith(
          "upload",
          expect.objectContaining({ size: 12345 }),
          expect.objectContaining({ id: "test-user" }),
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_SIZED;
      }
    });

    test("upload with malformed content-length → rejected with 400", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      await handler(
        mockReq("open", {
          query: { path: "/test.bin" },
          headers: {
            "content-length": "abc",
            "x-forwarded-user": "test-user",
            "x-forwarded-access-token": "test-token",
          },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Invalid Content-Length header.",
        }),
      );
    });

    test("upload with negative content-length → rejected with 400", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      await handler(
        mockReq("open", {
          query: { path: "/test.bin" },
          headers: {
            "content-length": "-1",
            "x-forwarded-user": "test-user",
            "x-forwarded-access-token": "test-token",
          },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test("upload with partially numeric content-length → rejected with 400", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      await handler(
        mockReq("open", {
          query: { path: "/test.bin" },
          headers: {
            "content-length": "123abc",
            "x-forwarded-user": "test-user",
            "x-forwarded-access-token": "test-token",
          },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test("SDK asUser(req) on policy volume → policy-wrapped API works", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const exported = plugin.exports();
      const handle = exported("public");

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "d.txt", path: "/d.txt", is_directory: false };
        },
      );

      const mockReqObj = {
        header: (name: string) => {
          if (name === "x-forwarded-user") return "test-user";
          if (name === "x-forwarded-access-token") return "test-token";
          return undefined;
        },
      } as any;

      const api = handle.asUser(mockReqObj);
      const result = await api.list();
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "d.txt" })]),
      );
    });

    test("SDK asUser(req) on policy volume + deny → throws PolicyDeniedError", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const exported = plugin.exports();
      const handle = exported("locked");

      const mockReqObj = {
        header: (name: string) => {
          if (name === "x-forwarded-user") return "test-user";
          if (name === "x-forwarded-access-token") return "test-token";
          return undefined;
        },
      } as any;

      const api = handle.asUser(mockReqObj);
      await expect(api.list()).rejects.toThrow(PolicyDeniedError);
    });

    test("SDK asUser(req) + denyAll() → delete throws PolicyDeniedError", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handle = plugin.exports()("locked");

      const mockReqObj = {
        header: (name: string) => {
          if (name === "x-forwarded-user") return "test-user";
          if (name === "x-forwarded-access-token") return "test-token";
          return undefined;
        },
      } as any;

      await expect(
        handle.asUser(mockReqObj).delete("/secret.txt"),
      ).rejects.toThrow(PolicyDeniedError);
    });

    test("SDK asUser(req) + publicRead() → upload throws PolicyDeniedError", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handle = plugin.exports()("public");

      const mockReqObj = {
        header: (name: string) => {
          if (name === "x-forwarded-user") return "test-user";
          if (name === "x-forwarded-access-token") return "test-token";
          return undefined;
        },
      } as any;

      await expect(
        handle.asUser(mockReqObj).upload("/file.bin", Buffer.from("data")),
      ).rejects.toThrow(PolicyDeniedError);
    });

    test("direct call on policy volume → enforces policy as SP", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handle = plugin.exports()("open");

      // Direct call on allowAll() volume succeeds (policy is checked but allows)
      const result = await handle.list();
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "d.txt" })]),
      );
    });

    test("direct SP call on denyAll() volume → throws PolicyDeniedError", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handle = plugin.exports()("locked");

      await expect(handle.list()).rejects.toThrow(PolicyDeniedError);
    });

    test("direct SP call → policy receives { isServicePrincipal: true }", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const spyConfig = {
        volumes: {
          spied: { policy: policySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_SPIED = "/Volumes/c/s/spied";

      try {
        const plugin = new FilesPlugin(spyConfig);
        const handle = plugin.exports()("spied");
        await handle.list();

        expect(policySpy).toHaveBeenCalledWith(
          "list",
          expect.objectContaining({ volume: "spied" }),
          expect.objectContaining({ isServicePrincipal: true }),
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_SPIED;
      }
    });

    test("asUser() call → policy receives user without isServicePrincipal", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const spyConfig = {
        volumes: {
          spied: { policy: policySpy },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_SPIED = "/Volumes/c/s/spied";

      try {
        const plugin = new FilesPlugin(spyConfig);
        const handle = plugin.exports()("spied");
        const mockReqObj = {
          header: (name: string) => {
            if (name === "x-forwarded-user") return "test-user";
            if (name === "x-forwarded-access-token") return "test-token";
            return undefined;
          },
        } as any;

        await handle.asUser(mockReqObj).list();

        expect(policySpy).toHaveBeenCalledWith(
          "list",
          expect.objectContaining({ volume: "spied" }),
          expect.objectContaining({ id: "test-user" }),
        );
        // Should NOT have isServicePrincipal set
        const userArg = policySpy.mock.calls[0][2];
        expect(userArg.isServicePrincipal).toBeUndefined();
      } finally {
        delete process.env.DATABRICKS_VOLUME_SPIED;
      }
    });

    test("denyAll() volume → read denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/read");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("publicRead() volume → read allowed", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/read");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue({
        contents: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("file content"));
            controller.close();
          },
        }),
      });

      await handler(mockReq("public", { query: { path: "/test.txt" } }), res);

      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
    });

    test("denyAll() volume → download denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/download");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.bin" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → raw denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → exists denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/exists");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → metadata denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/metadata");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → preview denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/preview");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → delete denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "delete", "/:volumeKey");
      const res = mockRes();

      await handler(mockReq("locked", { query: { path: "/test.txt" } }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("denyAll() volume → upload denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      await handler(
        mockReq("locked", {
          query: { path: "/test.bin" },
          headers: {
            "content-length": "100",
            "x-forwarded-user": "test-user",
            "x-forwarded-access-token": "test-token",
          },
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("not(publicRead()) volume → read denied with 403", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      await handler(mockReq("writeonly"), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
        }),
      );
    });

    test("not(publicRead()) volume → write allowed", async () => {
      const plugin = new FilesPlugin(POLICY_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/mkdir");
      const res = mockRes();

      mockClient.files.createDirectory.mockResolvedValue(undefined);

      await handler(mockReq("writeonly", { body: { path: "/dropbox" } }), res);

      // Should not receive 403
      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(403);
    });

    test("policy that throws → HTTP route returns 500 (fail closed)", async () => {
      const brokenConfig = {
        volumes: {
          broken: {
            policy: () => {
              throw new Error("policy crashed");
            },
          },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_BROKEN = "/Volumes/c/s/broken";

      try {
        const plugin = new FilesPlugin(brokenConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        await handler(mockReq("broken"), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: "Policy evaluation failed",
            plugin: "files",
          }),
        );
        // Must NOT be 403 — a broken policy is not a denial, it's a server error
        const statusCodes = (res.status.mock.calls as number[][]).map(
          (c) => c[0],
        );
        expect(statusCodes).not.toContain(403);
      } finally {
        delete process.env.DATABRICKS_VOLUME_BROKEN;
      }
    });

    test("policy that throws → programmatic API propagates the error", async () => {
      const brokenConfig = {
        volumes: {
          broken: {
            policy: () => {
              throw new Error("policy crashed");
            },
          },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_BROKEN = "/Volumes/c/s/broken";

      try {
        const plugin = new FilesPlugin(brokenConfig);
        const handle = plugin.exports()("broken");

        await expect(handle.list()).rejects.toThrow("policy crashed");
        await expect(handle.list()).rejects.not.toBeInstanceOf(
          PolicyDeniedError,
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_BROKEN;
      }
    });

    test("async policy that rejects → HTTP route returns 500 (fail closed)", async () => {
      const brokenConfig = {
        volumes: {
          broken: {
            policy: async () => {
              throw new Error("async policy crashed");
            },
          },
          uploads: {},
          exports: {},
        },
      };
      process.env.DATABRICKS_VOLUME_BROKEN = "/Volumes/c/s/broken";

      try {
        const plugin = new FilesPlugin(brokenConfig);
        const handler = getRouteHandler(plugin, "get", "/list");
        const res = mockRes();

        await handler(mockReq("broken"), res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: "Policy evaluation failed",
            plugin: "files",
          }),
        );
        const statusCodes = (res.status.mock.calls as number[][]).map(
          (c) => c[0],
        );
        expect(statusCodes).not.toContain(403);
      } finally {
        delete process.env.DATABRICKS_VOLUME_BROKEN;
      }
    });
  });

  describe("_resolveAuth config inheritance", () => {
    test("volume-level auth overrides plugin default", () => {
      const plugin = new FilesPlugin({
        auth: "service-principal",
        volumes: {
          uploads: { auth: "on-behalf-of-user" },
          exports: {},
        },
      });
      expect((plugin as any)._resolveAuth("uploads")).toBe("on-behalf-of-user");
    });

    test("volume without auth inherits plugin default", () => {
      const plugin = new FilesPlugin({
        auth: "on-behalf-of-user",
        volumes: {
          uploads: {},
          exports: {},
        },
      });
      expect((plugin as any)._resolveAuth("exports")).toBe("on-behalf-of-user");
    });

    test("neither volume nor plugin sets auth → defaults to service-principal", () => {
      const plugin = new FilesPlugin({
        volumes: {
          uploads: {},
          exports: {},
        },
      });
      expect((plugin as any)._resolveAuth("uploads")).toBe("service-principal");
    });

    test("createApp round-trip preserves auth field through public factory", async () => {
      // Satisfy the manifest's static `Files` resource requirement so
      // ResourceRegistry.enforceValidation passes during createApp.
      process.env.DATABRICKS_VOLUME_FILES = "/Volumes/catalog/schema/files";

      // Capture the FilesPlugin instance constructed by createApp by spying on
      // exports() (called when AppKit's plugin getter fires). This exercises
      // the public construction path so any future runtime config validator
      // (e.g. Zod) that drops the `auth` field would break this test.
      let captured: FilesPlugin | undefined;
      const exportsSpy = vi
        .spyOn(FilesPlugin.prototype, "exports")
        .mockImplementation(function (this: FilesPlugin) {
          captured = this;
          // Return a minimal stub; we only care about capturing `this`.
          const stub = (() => {
            throw new Error("not used in this test");
          }) as unknown as ReturnType<FilesPlugin["exports"]>;
          (stub as any).volume = () => {
            throw new Error("not used in this test");
          };
          return stub;
        });

      try {
        const appkit = await createApp({
          plugins: [
            files({
              auth: "on-behalf-of-user",
              volumes: {
                uploads: { auth: "service-principal" },
                exports: {},
              },
            }),
          ],
        });

        // Trigger the AppKit getter so wrapWithAsUser invokes exports()
        // and our spy captures the FilesPlugin instance.
        void (appkit as unknown as { files: unknown }).files;

        expect(captured).toBeInstanceOf(FilesPlugin);
        // Volume override wins over plugin-level default.
        expect((captured as any)._resolveAuth("uploads")).toBe(
          "service-principal",
        );
        // Volume with no explicit auth inherits the plugin default.
        expect((captured as any)._resolveAuth("exports")).toBe(
          "on-behalf-of-user",
        );
      } finally {
        exportsSpy.mockRestore();
        delete process.env.DATABRICKS_VOLUME_FILES;
      }
    });
  });

  describe("OBO identity selection", () => {
    function getRouteHandler(
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
      const res: any = { headersSent: false };
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.type = vi.fn().mockReturnValue(res);
      res.send = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      res.end = vi.fn();
      return res;
    }

    function mockReq(
      volumeKey: string,
      headers: Record<string, string>,
      overrides: Record<string, any> = {},
    ) {
      return {
        params: { volumeKey },
        query: {},
        ...overrides,
        headers,
        header: (name: string) => headers[name.toLowerCase()],
      };
    }

    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.DATABRICKS_VOLUME_OBO_VOL = "/Volumes/c/s/obo";
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      delete process.env.DATABRICKS_VOLUME_OBO_VOL;
    });

    test("OBO volume + valid token → policy receives { isServicePrincipal: false, id: <x-forwarded-user> }", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "o.txt", path: "/o.txt", is_directory: false };
        },
      );

      await handler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "test-token",
          "x-forwarded-user": "alice@example.com",
        }),
        res,
      );

      expect(policySpy).toHaveBeenCalledTimes(1);
      const userArg = policySpy.mock.calls[0][2];
      expect(userArg).toEqual({
        id: "alice@example.com",
        isServicePrincipal: false,
      });

      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
    });

    test("OBO volume + missing token + NODE_ENV != 'development' → 401, no SDK call", async () => {
      process.env.NODE_ENV = "production";
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      // No x-forwarded-access-token header.
      await handler(
        mockReq("obo_vol", {
          "x-forwarded-user": "alice@example.com",
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      const errBody = res.json.mock.calls[0][0];
      expect(errBody).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("Missing"),
          plugin: "files",
        }),
      );
      // The error shape comes from AuthenticationError.missingToken (mentions
      // x-forwarded-access-token in our message).
      expect(errBody.error).toMatch(/x-forwarded-access-token/);

      // Policy must not have been evaluated and the SDK must not have been
      // called.
      expect(policySpy).not.toHaveBeenCalled();
      expect(mockClient.files.listDirectoryContents).not.toHaveBeenCalled();
    });

    test("OBO volume + missing token + NODE_ENV === 'development' → exactly one warn, SP fallback proceeds", async () => {
      process.env.NODE_ENV = "development";
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "d.txt", path: "/d.txt", is_directory: false };
        },
      );

      // The plugin's logger.warn delegates to console.warn. Spy on console.warn
      // and filter for the unique substring of our dev-fallback message.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await handler(
          mockReq("obo_vol", {
            "x-forwarded-user": "alice@example.com",
          }),
          res,
        );

        const matchingWarns = warnSpy.mock.calls.filter((args) =>
          args.some(
            (a) =>
              typeof a === "string" &&
              a.includes(
                "OBO volume requested without x-forwarded-access-token",
              ),
          ),
        );
        expect(matchingWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }

      expect(policySpy).toHaveBeenCalledTimes(1);
      const userArg = policySpy.mock.calls[0][2];
      expect(userArg).toEqual(
        expect.objectContaining({ isServicePrincipal: true }),
      );

      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
    });

    test("OBO volume + valid token + policy denies → 403 PolicyDeniedError", async () => {
      const policySpy = vi.fn().mockReturnValue(false);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      await handler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "test-token",
          "x-forwarded-user": "alice@example.com",
        }),
        res,
      );

      expect(policySpy).toHaveBeenCalledTimes(1);
      const userArg = policySpy.mock.calls[0][2];
      expect(userArg).toEqual({
        id: "alice@example.com",
        isServicePrincipal: false,
      });

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
          plugin: "files",
        }),
      );
    });
  });

  describe("OBO read routes", () => {
    function getRouteHandler(
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
      const res: any = { headersSent: false };
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.type = vi.fn().mockReturnValue(res);
      res.send = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      res.end = vi.fn();
      return res;
    }

    function mockReq(
      volumeKey: string,
      headers: Record<string, string>,
      overrides: Record<string, any> = {},
    ) {
      return {
        params: { volumeKey },
        query: {},
        ...overrides,
        headers,
        header: (name: string) => headers[name.toLowerCase()],
      };
    }

    /**
     * Replace the default `getCurrentUserId` mock with one that delegates to
     * the real implementation, so that calls inside `runInUserContext` resolve
     * to the wrapped UserContext's `userId` (and the per-user cache key
     * derived from it).
     */
    async function useRealGetCurrentUserId() {
      const actual =
        await vi.importActual<typeof import("../../../context")>(
          "../../../context",
        );
      const ctx = await import("../../../context");
      vi.mocked(ctx.getCurrentUserId).mockImplementation(
        actual.getCurrentUserId,
      );
    }

    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.DATABRICKS_VOLUME_OBO_VOL = "/Volumes/c/s/obo";
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      delete process.env.DATABRICKS_VOLUME_OBO_VOL;
    });

    test("OBO list + valid token wraps SDK call in user context (alice's userId resolves inside the wrapped fn)", async () => {
      await useRealGetCurrentUserId();
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      // Snapshot the user IDs observed inside each SDK invocation so we can
      // assert that the SDK call ran inside `runInUserContext` with the
      // expected user identity.
      const observedUserIds: string[] = [];
      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          // getCurrentUserId() inside the wrapped fn should resolve to alice.
          const ctx = await import("../../../context");
          observedUserIds.push(ctx.getCurrentUserId());
          yield { name: "o.txt", path: "/o.txt", is_directory: false };
        },
      );

      await handler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "test-token",
          "x-forwarded-user": "alice@example.com",
        }),
        res,
      );

      expect(observedUserIds).toEqual(["alice@example.com"]);

      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
      expect(statusCodes).not.toContain(500);
    });

    test("OBO read happy path: valid token + policy allows + UC allows → 200", async () => {
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/read");
      const res = mockRes();

      // The connector reads via files.download — return a valid 200-ish
      // response with content body.
      mockClient.files.download.mockImplementation(async () => ({
        contents: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"));
            controller.close();
          },
        }),
      }));

      await handler(
        mockReq(
          "obo_vol",
          {
            "x-forwarded-access-token": "test-token",
            "x-forwarded-user": "alice@example.com",
          },
          { query: { path: "hello.txt" } },
        ),
        res,
      );

      // Both gates passed: policy was consulted with OBO identity, and the
      // SDK's response was relayed back to the client.
      expect(policySpy).toHaveBeenCalledTimes(1);
      const userArg = policySpy.mock.calls[0][2];
      expect(userArg).toEqual({
        id: "alice@example.com",
        isServicePrincipal: false,
      });

      // 2xx path: handler called res.type/send rather than res.status(non-2xx).
      const statusCodes = (res.status.mock.calls as number[][]).map(
        (c) => c[0],
      );
      expect(statusCodes).not.toContain(401);
      expect(statusCodes).not.toContain(403);
      expect(statusCodes).not.toContain(500);
      expect(res.send).toHaveBeenCalled();
    });

    test("Cache isolation: same path, two users on OBO volume → two distinct cache keys", async () => {
      await useRealGetCurrentUserId();
      const policySpy = vi.fn().mockReturnValue(true);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "get", "/list");

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "f.txt", path: "/f.txt", is_directory: false };
        },
      );

      // Alice's request.
      await handler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "alice@example.com",
        }),
        mockRes(),
      );

      // Bob's request — same volume, same path.
      await handler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "bob-token",
          "x-forwarded-user": "bob@example.com",
        }),
        mockRes(),
      );

      // The cache layer is consulted via getOrExecute(cacheKey, fn, userKey).
      // For OBO volumes the `userKey` argument must be the real user's ID
      // (resolved by getCurrentUserId() inside the runInUserContext scope),
      // so the two requests produce two distinct cache entries.
      const userKeys = mockCacheInstance.getOrExecute.mock.calls.map(
        (c: unknown[]) => c[2],
      );
      expect(userKeys).toEqual(["alice@example.com", "bob@example.com"]);
      expect(new Set(userKeys).size).toBe(2);
    });

    test("SP/OBO cache no-collide: same path on SP volume vs OBO volume → distinct cache keys", async () => {
      await useRealGetCurrentUserId();
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: {
            auth: "on-behalf-of-user",
            policy: policy.allowAll(),
          },
          // SP-mode volume (default auth).
          uploads: { policy: policy.allowAll() },
          exports: {},
        },
      });

      const listHandler = getRouteHandler(plugin, "get", "/list");

      mockClient.files.listDirectoryContents.mockImplementation(
        async function* () {
          yield { name: "f.txt", path: "/f.txt", is_directory: false };
        },
      );

      // SP volume request — `getCurrentUserId()` outside any user context
      // returns the service principal's identity (the underlying real impl
      // reads `ServiceContext.serviceUserId`).
      await listHandler(
        mockReq("uploads", {
          "x-forwarded-access-token": "sp-token-ignored",
          "x-forwarded-user": "alice@example.com",
        }),
        mockRes(),
      );

      // OBO volume request — same human user, but execution is wrapped in
      // runInUserContext so `userKey` resolves to alice's ID, not the SP's.
      await listHandler(
        mockReq("obo_vol", {
          "x-forwarded-access-token": "alice-token",
          "x-forwarded-user": "alice@example.com",
        }),
        mockRes(),
      );

      const calls = mockCacheInstance.getOrExecute.mock.calls;
      expect(calls).toHaveLength(2);

      // The cacheKey is the first arg — the SP and OBO volumes already
      // namespace cache entries by `volumeKey`, so the array form differs.
      const cacheKeys = calls.map((c: unknown[]) => c[0]);
      expect(cacheKeys[0]).not.toEqual(cacheKeys[1]);

      // Defense-in-depth: even if the array-form cacheKey matched, the
      // userKey differs because OBO runs under runInUserContext while SP
      // runs in the SP's serviceUserId.
      const userKeys = calls.map((c: unknown[]) => c[2]);
      expect(userKeys[0]).not.toEqual(userKeys[1]);
    });
  });

  describe("OBO write routes", () => {
    function getRouteHandler(
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
      const res: any = { headersSent: false };
      res.status = vi.fn().mockReturnValue(res);
      res.json = vi.fn().mockReturnValue(res);
      res.type = vi.fn().mockReturnValue(res);
      res.send = vi.fn().mockReturnValue(res);
      res.setHeader = vi.fn().mockReturnValue(res);
      res.end = vi.fn();
      return res;
    }

    /**
     * `_handleUpload` calls `Readable.toWeb(req)` on the express request, so
     * the mock req must be (or extend) a real Node Readable stream. Build one
     * from the supplied body bytes and tack on the express-shaped helpers.
     */
    function mockUploadReq(
      volumeKey: string,
      headers: Record<string, string>,
      body: string | Buffer = "",
      overrides: Record<string, any> = {},
    ) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const stream = Readable.from([buf]) as Readable & {
        params?: any;
        query?: any;
        headers?: any;
        header?: (name: string) => string | undefined;
      };
      stream.params = { volumeKey };
      // Relative path so the connector's `resolvePath` joins it with the
      // volume's defaultVolume from `DATABRICKS_VOLUME_OBO_VOL`.
      stream.query = { path: "upload-target.bin" };
      stream.headers = headers;
      stream.header = (name: string) => headers[name.toLowerCase()];
      Object.assign(stream, overrides);
      return stream;
    }

    function mockReq(
      volumeKey: string,
      headers: Record<string, string>,
      overrides: Record<string, any> = {},
    ) {
      return {
        params: { volumeKey },
        query: {},
        body: {},
        ...overrides,
        headers,
        header: (name: string) => headers[name.toLowerCase()],
      };
    }

    /**
     * Replace the default `getCurrentUserId` mock with the real implementation
     * so calls inside `runInUserContext` resolve to the wrapped UserContext's
     * `userId` (mirrors the helper used by the `OBO read routes` block).
     */
    async function useRealGetCurrentUserId() {
      const actual =
        await vi.importActual<typeof import("../../../context")>(
          "../../../context",
        );
      const ctx = await import("../../../context");
      vi.mocked(ctx.getCurrentUserId).mockImplementation(
        actual.getCurrentUserId,
      );
    }

    /**
     * Replace the default `getWorkspaceClient` mock with the real
     * implementation so that calls inside `runInUserContext` return the
     * UserContext's `client` (the user-token-authenticated WorkspaceClient)
     * while calls outside the user context fall back to the
     * service-principal client from `ServiceContext.get()`. Required to
     * exercise the real `_runWithAuth → runInUserContext → getWorkspaceClient
     * → client.config.authenticate → fetch headers` chain.
     */
    async function useRealGetWorkspaceClient() {
      const actual =
        await vi.importActual<typeof import("../../../context")>(
          "../../../context",
        );
      const ctx = await import("../../../context");
      vi.mocked(ctx.getWorkspaceClient).mockImplementation(
        actual.getWorkspaceClient,
      );
    }

    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.DATABRICKS_VOLUME_OBO_VOL = "/Volumes/c/s/obo";
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      delete process.env.DATABRICKS_VOLUME_OBO_VOL;
      vi.unstubAllGlobals();
    });

    /**
     * NON-NEGOTIABLE upload-headers contract.
     *
     * `_handleUpload` does a hand-rolled `fetch PUT` (not a typed SDK call)
     * via the connector's `upload()`. Inside `_runWithAuth` on an OBO volume,
     * the chain is:
     *
     *     getWorkspaceClient()           → user-token WorkspaceClient
     *     client.config.authenticate(h)  → injects "Bearer <user-token>"
     *     fetch(url, { headers })        → outgoing request as the user
     *
     * This test pins that chain end-to-end. If any future SDK upgrade or
     * refactor changes `client.config.authenticate`'s signature, removes the
     * `runInUserContext` wrap from `_handleUpload`, or rewires
     * `getWorkspaceClient()` so it returns the SP client inside the OBO
     * scope, the user-token Authorization header will not reach `fetch` and
     * this assertion fails. SP-token would silently leak to UC otherwise.
     */
    test("OBO upload: outgoing fetch PUT carries user-token Authorization header (not SP)", async () => {
      await useRealGetCurrentUserId();
      await useRealGetWorkspaceClient();

      // SP-token marker — what the existing mockClient would inject if the
      // OBO wrap leaked. We assert this NEVER reaches the outgoing fetch.
      mockClient.config.authenticate.mockImplementation(
        async (headers: Headers) => {
          headers.set("Authorization", "Bearer SP-TOKEN");
        },
      );

      // User-token marker — what the OBO scope MUST inject.
      const userClient = {
        config: {
          host: "https://test.databricks.com",
          authenticate: vi.fn(async (headers: Headers) => {
            headers.set("Authorization", "Bearer USER-TOKEN-FOO");
          }),
        },
        // `_handleUpload` only routes through the connector's `upload()`,
        // which uses host + authenticate + fetch. No `files.*` accessor is
        // touched on the user client during this path.
      };

      // Wire `_buildUserContextOrNull → ServiceContext.createUserContext` to
      // return a UserContext whose `client` is our user-token client. This
      // is the same hook `mockServiceContext` already installs; we just
      // override its impl for this test.
      serviceContextMock.createUserContextSpy.mockImplementation(
        (_token: string, userId: string) => ({
          client: userClient as any,
          userId,
          warehouseId: serviceContextMock.serviceContext.warehouseId,
          workspaceId: serviceContextMock.serviceContext.workspaceId,
          isUserContext: true,
        }),
      );

      // Capture the outgoing PUT.
      const fetchSpy = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: async () => "" });
      vi.stubGlobal("fetch", fetchSpy);

      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: {
            auth: "on-behalf-of-user",
            policy: policy.allowAll(),
          },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      await handler(
        mockUploadReq(
          "obo_vol",
          {
            "x-forwarded-access-token": "alice-token",
            "x-forwarded-user": "alice@example.com",
            "content-length": "5",
          },
          "hello",
        ),
        res,
      );

      // The user-token authenticator was consulted exactly when upload ran.
      expect(userClient.config.authenticate).toHaveBeenCalledTimes(1);

      // The hand-rolled fetch PUT happened exactly once.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchArgs = fetchSpy.mock.calls[0];
      const init = fetchArgs[1] as RequestInit & { headers: Headers };
      expect(init.method).toBe("PUT");

      // The contract — proves the user-token Authorization header reached
      // fetch. Toggling the `_runWithAuth` wrap off in `_handleUpload`
      // breaks this assertion (fetch would carry "Bearer SP-TOKEN" instead).
      expect(init.headers.get("Authorization")).toBe("Bearer USER-TOKEN-FOO");
      expect(init.headers.get("Authorization")).not.toBe("Bearer SP-TOKEN");

      // Defense-in-depth: SP authenticator was NOT called along the OBO path.
      expect(mockClient.config.authenticate).not.toHaveBeenCalled();
    });

    test("OBO upload + missing token + NODE_ENV=production → 401 before any SDK or fetch call", async () => {
      process.env.NODE_ENV = "production";

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: {
            auth: "on-behalf-of-user",
            policy: policy.allowAll(),
          },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      // No x-forwarded-access-token header.
      await handler(
        mockUploadReq(
          "obo_vol",
          {
            "x-forwarded-user": "alice@example.com",
            "content-length": "5",
          },
          "hello",
        ),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      const errBody = res.json.mock.calls[0][0];
      expect(errBody).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("Missing"),
          plugin: "files",
        }),
      );
      expect(errBody.error).toMatch(/x-forwarded-access-token/);

      // Neither the SDK upload nor the hand-rolled fetch ran.
      expect(mockClient.files.upload).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("OBO mkdir + policy denies → 403 PolicyDeniedError; SDK not invoked", async () => {
      const policySpy = vi.fn().mockReturnValue(false);
      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: { auth: "on-behalf-of-user", policy: policySpy },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "post", "/mkdir");
      const res = mockRes();

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await handler(
        mockReq(
          "obo_vol",
          {
            "x-forwarded-access-token": "alice-token",
            "x-forwarded-user": "alice@example.com",
          },
          { body: { path: "/new-dir" } },
        ),
        res,
      );

      // Policy was consulted with the OBO identity.
      expect(policySpy).toHaveBeenCalledTimes(1);
      const userArg = policySpy.mock.calls[0][2];
      expect(userArg).toEqual({
        id: "alice@example.com",
        isServicePrincipal: false,
      });

      // 403 PolicyDeniedError shape.
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("Policy denied"),
          plugin: "files",
        }),
      );

      // SDK + fetch not invoked.
      expect(mockClient.files.createDirectory).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("OBO delete + valid token + UC denies → user-token client invoked, error propagated", async () => {
      await useRealGetCurrentUserId();
      await useRealGetWorkspaceClient();

      // Distinct user-token client with a `files.delete` that mimics a UC
      // failure (e.g. 403 from UC because the user lacks privilege).
      const userClient = {
        config: {
          host: "https://test.databricks.com",
          authenticate: vi.fn(async (h: Headers) => {
            h.set("Authorization", "Bearer USER-TOKEN-DEL");
          }),
        },
        files: {
          delete: vi.fn(async () => {
            throw new MockApiError("UC denied", 403);
          }),
        },
      };

      serviceContextMock.createUserContextSpy.mockImplementation(
        (_token: string, userId: string) => ({
          client: userClient as any,
          userId,
          warehouseId: serviceContextMock.serviceContext.warehouseId,
          workspaceId: serviceContextMock.serviceContext.workspaceId,
          isUserContext: true,
        }),
      );

      const plugin = new FilesPlugin({
        volumes: {
          obo_vol: {
            auth: "on-behalf-of-user",
            policy: policy.allowAll(),
          },
          uploads: {},
          exports: {},
        },
      });
      const handler = getRouteHandler(plugin, "delete", "/:volumeKey");
      const res = mockRes();

      await handler(
        mockReq(
          "obo_vol",
          {
            "x-forwarded-access-token": "alice-token",
            "x-forwarded-user": "alice@example.com",
          },
          { query: { path: "doomed.txt" } },
        ),
        res,
      );

      // The user-token client was used, not the SP one.
      expect(userClient.files.delete).toHaveBeenCalledTimes(1);
      expect(mockClient.files.delete).not.toHaveBeenCalled();

      // The UC error surfaced as 403 (the ApiError statusCode).
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ plugin: "files" }),
      );
    });
  });

  describe("VolumeHandle.asUser SDK identity", () => {
    /**
     * Replace the default `getWorkspaceClient` mock with the real
     * implementation so that calls inside `runInUserContext` return the
     * UserContext's `client` (the user-token-authenticated WorkspaceClient)
     * while calls outside the user context fall back to the
     * service-principal client from `ServiceContext.get()`.
     */
    async function useRealGetWorkspaceClient() {
      const actual =
        await vi.importActual<typeof import("../../../context")>(
          "../../../context",
        );
      const ctx = await import("../../../context");
      vi.mocked(ctx.getWorkspaceClient).mockImplementation(
        actual.getWorkspaceClient,
      );
    }

    /**
     * Build a minimal mock express.Request with the supplied headers. Only
     * `header(name)` is consulted by `VolumeHandle.asUser`.
     */
    function mockReq(headers: Record<string, string>) {
      return {
        header: (name: string) => headers[name.toLowerCase()],
      } as any;
    }

    let originalNodeEnv: string | undefined;

    beforeEach(async () => {
      originalNodeEnv = process.env.NODE_ENV;
      // Restore the default `getWorkspaceClient(() => mockClient)` mock in
      // case a previous test in this block called `useRealGetWorkspaceClient`
      // — Vitest's `vi.clearAllMocks` clears call history but not impls.
      const ctx = await import("../../../context");
      vi.mocked(ctx.getWorkspaceClient).mockImplementation(
        () => mockClient as any,
      );
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    test("asUser on SP-configured volume → SDK call goes through user-token client (hard override)", async () => {
      // Use the real ALS-driven `getWorkspaceClient` so that calls inside
      // `runInUserContext` resolve to the wrapped UserContext's client and
      // calls outside fall through to ServiceContext.client (which lacks
      // `.files` — making any leak through the SP path crash loudly).
      await useRealGetWorkspaceClient();

      // Distinct user-token client whose `listDirectoryContents` is the
      // one we expect `asUser` to route through.
      const userListSpy = vi.fn(async function* () {
        yield { name: "user.txt", path: "/user.txt", is_directory: false };
      });
      const userClient = {
        config: {
          host: "https://test.databricks.com",
          authenticate: vi.fn(),
        },
        files: { listDirectoryContents: userListSpy },
      };

      // Wire `_buildUserContextOrNull → ServiceContext.createUserContext` to
      // return a UserContext whose `client` is our user-token client.
      serviceContextMock.createUserContextSpy.mockImplementation(
        (_token: string, userId: string) => ({
          client: userClient as any,
          userId,
          warehouseId: serviceContextMock.serviceContext.warehouseId,
          workspaceId: serviceContextMock.serviceContext.workspaceId,
          isUserContext: true,
        }),
      );

      // Set the SP volume's default path BEFORE plugin construction so the
      // connector picks it up.
      process.env.DATABRICKS_VOLUME_SP_VOL = "/Volumes/c/s/sp";
      try {
        const plugin = new FilesPlugin({
          volumes: {
            // SP-configured volume (the auth: "service-principal" default).
            sp_vol: { auth: "service-principal", policy: policy.allowAll() },
            uploads: {},
            exports: {},
          },
        });

        const handle = plugin.exports()("sp_vol");
        const userApi = handle.asUser(
          mockReq({
            "x-forwarded-access-token": "alice-token",
            "x-forwarded-user": "alice@example.com",
          }),
        );

        // Materialize the async iterator — the connector iterates the SDK
        // generator and aggregates results.
        await userApi.list("subdir");

        // The user-token client served the SDK call (proof the
        // `runInUserContext` wrap took effect).
        expect(userListSpy).toHaveBeenCalledTimes(1);
        // Defense-in-depth: a UserContext was constructed for the request.
        expect(serviceContextMock.createUserContextSpy).toHaveBeenCalledTimes(
          1,
        );
      } finally {
        delete process.env.DATABRICKS_VOLUME_SP_VOL;
      }
    });

    test("programmatic call on OBO volume without asUser → no runInUserContext wrap; SDK runs through default getWorkspaceClient (SP at top level)", async () => {
      // Discovery note: programmatic calls (no `req`) cannot synthesize a
      // user identity. The OBO-volume "execute as user" behavior is wired
      // through the HTTP route layer's `_runWithAuth`, which builds a
      // UserContext from the request headers. There is no equivalent for
      // the programmatic path — `appKit.files("obo-vol").list()` (no
      // `asUser`) executes against whatever `getWorkspaceClient()` returns
      // in the current ALS scope, which at the top level is the SP client.
      // This test pins that reality. The task spec's framing of "OBO
      // default executes as user via volume default" is HTTP-only.

      // We rely on the default mocked `getWorkspaceClient(() => mockClient)`
      // so the SP client returned is the file-aware fixture.
      const spListSpy = vi.fn(async function* () {
        yield { name: "sp.txt", path: "/sp.txt", is_directory: false };
      });
      mockClient.files.listDirectoryContents.mockImplementation(spListSpy);

      // Spy on createUserContext to confirm no wrap happened.
      serviceContextMock.createUserContextSpy.mockClear();

      process.env.DATABRICKS_VOLUME_OBO_VOL = "/Volumes/c/s/obo";
      try {
        const plugin = new FilesPlugin({
          volumes: {
            obo_vol: {
              auth: "on-behalf-of-user",
              policy: policy.allowAll(),
            },
            uploads: {},
            exports: {},
          },
        });

        const handle = plugin.exports()("obo_vol");
        await handle.list("subdir"); // no asUser; pure programmatic call

        // The default `mockClient` (SP fixture) served the call. No
        // user-context wrap exists at the top of the call stack — the OBO
        // semantic only applies on the HTTP route path.
        expect(spListSpy).toHaveBeenCalledTimes(1);
        expect(serviceContextMock.createUserContextSpy).not.toHaveBeenCalled();
      } finally {
        delete process.env.DATABRICKS_VOLUME_OBO_VOL;
      }
    });

    test("programmatic call on SP volume without asUser → SDK runs as SP; runInUserContext is not invoked (status-quo guard)", async () => {
      // Default mocked `getWorkspaceClient(() => mockClient)`; no
      // ALS-driven dispatch.
      const spListSpy = vi.fn(async function* () {
        yield { name: "sp.txt", path: "/sp.txt", is_directory: false };
      });
      mockClient.files.listDirectoryContents.mockImplementation(spListSpy);

      serviceContextMock.createUserContextSpy.mockClear();

      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handle = plugin.exports()("uploads");
      await handle.list("subdir"); // no asUser; pure SP path

      // The SP client served the SDK call.
      expect(spListSpy).toHaveBeenCalledTimes(1);
      // No UserContext was ever built — the SP default path shouldn't go
      // anywhere near `createUserContext`.
      expect(serviceContextMock.createUserContextSpy).not.toHaveBeenCalled();
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
