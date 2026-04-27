import { Readable } from "node:stream";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AuthenticationError } from "../../../errors";
import { FilesPlugin } from "../plugin";
import { policy } from "../policy";

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
    uploads: { maxUploadSize: 100_000_000, policy: policy.allowAll() },
    exports: { policy: policy.allowAll() },
  },
};

/**
 * Helper to get a route handler from the plugin. Registers routes on a mock
 * router and returns the handler matching the given method + path suffix.
 */
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
  if (!call) throw new Error(`No route found for ${method} ...${pathSuffix}`);
  return call[call.length - 1] as (req: any, res: any) => Promise<void>;
}

/**
 * Creates a mock Express response with all methods needed by the route handlers.
 */
function mockRes() {
  const res: any = {
    headersSent: false,
  };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.write = vi.fn().mockReturnValue(true);
  res.destroy = vi.fn();
  res.end = vi.fn();
  res.on = vi.fn().mockReturnValue(res);
  res.once = vi.fn().mockReturnValue(res);
  res.emit = vi.fn().mockReturnValue(true);
  res.removeListener = vi.fn().mockReturnValue(res);
  res.pipe = vi.fn().mockReturnValue(res);
  return res;
}

/**
 * Creates a mock Express request with the auth headers needed by the plugin's
 * `asUser()` proxy.
 */
function mockReq(volumeKey: string, overrides: Record<string, any> = {}): any {
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "test-token",
    "x-forwarded-user": "test-user",
    ...(overrides.headers ?? {}),
  };

  const req: any = {
    params: { volumeKey },
    query: {},
    ...overrides,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  };

  return req;
}

/**
 * Creates a mock Express request that behaves as a Node Readable stream,
 * suitable for the upload handler which calls Readable.toWeb(req).
 */
function mockUploadReq(
  volumeKey: string,
  bodyChunks: Buffer[],
  overrides: Record<string, any> = {},
): any {
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "test-token",
    "x-forwarded-user": "test-user",
    ...(overrides.headers ?? {}),
  };

  // Create a real Node Readable so Readable.toWeb() works
  let chunkIndex = 0;
  const stream = new Readable({
    read() {
      if (chunkIndex < bodyChunks.length) {
        this.push(bodyChunks[chunkIndex++]);
      } else {
        this.push(null);
      }
    },
  });

  // Patch stream with Express request properties
  (stream as any).params = { volumeKey };
  (stream as any).query = overrides.query ?? {};
  (stream as any).headers = headers;
  (stream as any).header = (name: string) => headers[name.toLowerCase()];
  (stream as any).body = overrides.body;

  return stream;
}

describe("FilesPlugin - Upload, Write, and Error Handling", () => {
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

  // ──────────────────────────────────────────────────────────────────────
  // 1. _handleApiError: AuthenticationError -> 401, ApiError variants,
  //    non-ApiError -> 500
  // ──────────────────────────────────────────────────────────────────────
  describe("_handleApiError", () => {
    test("AuthenticationError returns 401 with error message", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new AuthenticationError("Missing token"),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Missing token",
        plugin: "files",
      });
    });

    test("ApiError with 4xx status preserves status and message", () => {
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

    test("ApiError with 404 preserves status", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new MockApiError("Not found", 404),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Not found",
        statusCode: 404,
        plugin: "files",
      });
    });

    test("ApiError with 409 Conflict preserves status", () => {
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

    test("AuthenticationError via route (missing identity headers in production)", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/list");
      const res = mockRes();

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      // No identity headers in production should surface as a 401 from the
      // plugin's _extractUser path before any SDK call is made.
      try {
        await handler(
          {
            params: { volumeKey: "uploads" },
            query: {},
            headers: {},
            header: () => undefined,
          },
          res,
        );

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.stringContaining("x-forwarded-user"),
            plugin: "files",
          }),
        );
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Upload path: TransformStream size enforcement during streaming
  // ──────────────────────────────────────────────────────────────────────
  describe("Upload stream mid-transfer size enforcement", () => {
    test("upload exceeding size mid-stream is caught by execute and returns error", async () => {
      const plugin = new FilesPlugin({
        volumes: {
          uploads: { maxUploadSize: 50, policy: policy.allowAll() },
        },
      });
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      // Two chunks: 30 + 30 = 60 > maxSize of 50
      const req = mockUploadReq(
        "uploads",
        [Buffer.alloc(30), Buffer.alloc(30)],
        {
          query: { path: "/Volumes/catalog/schema/uploads/file.bin" },
          // No content-length header so the pre-check does not catch it
        },
      );

      // Spy on the connector's upload to consume the stream (the
      // TransformStream size limiter fires when chunks are read).
      const connector = (plugin as any).volumeConnectors.uploads;
      vi.spyOn(connector, "upload").mockImplementation((async (
        ...args: unknown[]
      ) => {
        const contents = args[2];
        const reader = (contents as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }) as never);

      await handler(req, res);

      // The stream size error is caught by execute() and returned as
      // {ok: false, status: 500}. The Content-Length pre-check (tested
      // separately) catches oversized uploads before streaming starts.
      const statusCalls = res.status.mock.calls.flat();
      expect(statusCalls).toContain(500);
    });

    test("outer catch returns 413 for stream size error escaping execute", async () => {
      // The outer catch in _handleUpload has a specific check for the
      // "exceeds maximum allowed size" message. This tests that path by
      // making execute() re-throw instead of catching.
      const plugin = new FilesPlugin({
        volumes: {
          uploads: { maxUploadSize: 50, policy: policy.allowAll() },
        },
      });
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      const req = mockUploadReq("uploads", [Buffer.from("data")], {
        query: { path: "/Volumes/catalog/schema/uploads/file.bin" },
      });

      // Override trackWrite to throw the size error directly
      vi.spyOn(plugin as any, "trackWrite").mockRejectedValue(
        new Error("Upload stream exceeds maximum allowed size (50 bytes)"),
      );

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("exceeds maximum allowed size"),
          plugin: "files",
        }),
      );
    });

    test("upload within size limit succeeds", async () => {
      const plugin = new FilesPlugin({
        volumes: {
          uploads: { maxUploadSize: 100, policy: policy.allowAll() },
        },
      });
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      const req = mockUploadReq(
        "uploads",
        [Buffer.from("small file content")],
        {
          query: { path: "/Volumes/catalog/schema/uploads/small.txt" },
        },
      );

      const connector = (plugin as any).volumeConnectors.uploads;
      vi.spyOn(connector, "upload").mockImplementation((async (
        ...args: unknown[]
      ) => {
        const contents = args[2];
        const reader = (contents as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }) as never);

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Upload: cache invalidation after successful upload
  // ──────────────────────────────────────────────────────────────────────
  describe("Upload cache invalidation", () => {
    test("successful upload calls cache.delete for parent directory", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      const req = mockUploadReq("uploads", [Buffer.from("file content")], {
        query: { path: "/Volumes/catalog/schema/uploads/dir/file.txt" },
      });

      const connector = (plugin as any).volumeConnectors.uploads;
      vi.spyOn(connector, "upload").mockImplementation((async (
        ...args: unknown[]
      ) => {
        const contents = args[2];
        const reader = (contents as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }) as never);

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      // _invalidateListCache should call generateKey and then delete
      expect(mockCacheInstance.generateKey).toHaveBeenCalled();
      expect(mockCacheInstance.delete).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. Raw endpoint: CSP sandbox header and safe vs unsafe content type
  // ──────────────────────────────────────────────────────────────────────
  describe("Raw endpoint security headers", () => {
    function makeStreamResponse(content: string) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
      return { contents: stream };
    }

    test("raw endpoint sets CSP sandbox header", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue(makeStreamResponse("data"));

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/data.json" },
        }),
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Security-Policy",
        "sandbox",
      );
    });

    test("raw endpoint with safe content type (image/png) does not set Content-Disposition", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue(
        makeStreamResponse("PNG data"),
      );

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/image.png" },
        }),
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Security-Policy",
        "sandbox",
      );

      // Content-Disposition should NOT be set for safe inline types
      const dispositionCalls = res.setHeader.mock.calls.filter(
        (c: string[]) => c[0] === "Content-Disposition",
      );
      expect(dispositionCalls).toHaveLength(0);
    });

    test("raw endpoint with unsafe content type (text/html) forces download", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue(
        makeStreamResponse("<html></html>"),
      );

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/page.html" },
        }),
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html");
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Security-Policy",
        "sandbox",
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="page.html"',
      );
    });

    test("raw endpoint with SVG forces download", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue(
        makeStreamResponse("<svg></svg>"),
      );

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/icon.svg" },
        }),
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="icon.svg"',
      );
    });

    test("raw endpoint sets X-Content-Type-Options: nosniff", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
      const res = mockRes();

      mockClient.files.download.mockResolvedValue(
        makeStreamResponse("content"),
      );

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/file.txt" },
        }),
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        "X-Content-Type-Options",
        "nosniff",
      );
    });

    test("raw endpoint with missing path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/raw");
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
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Download endpoint: Content-Disposition with sanitized filename
  // ──────────────────────────────────────────────────────────────────────
  describe("Download endpoint Content-Disposition", () => {
    function makeStreamResponse(content: string) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
      return { contents: stream };
    }

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

      // Quotes in filenames should be escaped
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

  // ──────────────────────────────────────────────────────────────────────
  // 6. Delete endpoint: cache invalidation
  // ──────────────────────────────────────────────────────────────────────
  describe("Delete cache invalidation", () => {
    test("successful delete invalidates list cache", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "delete", "");
      const res = mockRes();

      mockClient.files.delete.mockResolvedValue(undefined);

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/dir/file.txt" },
        }),
        res,
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(mockCacheInstance.generateKey).toHaveBeenCalled();
      expect(mockCacheInstance.delete).toHaveBeenCalled();
    });

    test("delete without path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "delete", "");
      const res = mockRes();

      await handler(mockReq("uploads", { query: {} }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "path is required" }),
      );
    });

    test("delete that throws ApiError returns proper status", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "delete", "");
      const res = mockRes();

      mockClient.files.delete.mockRejectedValue(
        new MockApiError("Not found", 404),
      );

      await handler(
        mockReq("uploads", {
          query: { path: "/Volumes/catalog/schema/uploads/missing.txt" },
        }),
        res,
      );

      // SDK errors go through execute() which returns {ok: false, status: 404}
      // then _sendStatusError is called with STATUS_CODES[404] = "Not Found"
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Mkdir endpoint: cache invalidation
  // ──────────────────────────────────────────────────────────────────────
  describe("Mkdir cache invalidation", () => {
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

  // ──────────────────────────────────────────────────────────────────────
  // 8. Shutdown: trackWrite waits for in-flight writes, deadline timeout
  // ──────────────────────────────────────────────────────────────────────
  describe("Shutdown and trackWrite", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("shutdown waits for in-flight writes to complete", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);

      // Simulate an in-flight write
      (plugin as any).inflightWrites = 1;

      const shutdownPromise = plugin.shutdown();

      // After 500ms the shutdown loop should still be waiting
      await vi.advanceTimersByTimeAsync(500);

      // Simulate the write completing
      (plugin as any).inflightWrites = 0;

      await vi.advanceTimersByTimeAsync(500);
      await shutdownPromise;

      // Shutdown should have completed
      expect((plugin as any).inflightWrites).toBe(0);
    });

    test("shutdown times out after 10 seconds with pending writes", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

      // Simulate an in-flight write that never completes
      (plugin as any).inflightWrites = 2;

      const shutdownPromise = plugin.shutdown();

      // Advance past the 10-second deadline
      await vi.advanceTimersByTimeAsync(11_000);
      await shutdownPromise;

      // Should still call abortAll even after timeout
      expect(abortAllSpy).toHaveBeenCalled();
      // inflightWrites remains > 0 since the writes never completed
      expect((plugin as any).inflightWrites).toBe(2);
    });

    test("shutdown completes immediately when no in-flight writes", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

      (plugin as any).inflightWrites = 0;

      const shutdownPromise = plugin.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      await shutdownPromise;

      expect(abortAllSpy).toHaveBeenCalled();
    });

    test("trackWrite increments and decrements inflightWrites correctly", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      expect((plugin as any).inflightWrites).toBe(0);

      let resolveInner!: (value: string) => void;
      const innerPromise = new Promise<string>((r) => {
        resolveInner = r;
      });

      const trackPromise = (plugin as any).trackWrite(() => innerPromise);

      // While the tracked fn is running, inflightWrites should be 1
      expect((plugin as any).inflightWrites).toBe(1);

      resolveInner("done");
      const result = await trackPromise;

      expect(result).toBe("done");
      expect((plugin as any).inflightWrites).toBe(0);
    });

    test("trackWrite decrements inflightWrites even on rejection", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);

      const trackPromise = (plugin as any).trackWrite(() =>
        Promise.reject(new Error("write failed")),
      );

      await expect(trackPromise).rejects.toThrow("write failed");
      expect((plugin as any).inflightWrites).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 9. Volume discovery: merging explicit config with env vars
  // ──────────────────────────────────────────────────────────────────────
  describe("Volume discovery merging", () => {
    test("explicit config takes priority over env vars", () => {
      const volumes = FilesPlugin.discoverVolumes({
        volumes: {
          uploads: { maxUploadSize: 42 },
          custom: { maxUploadSize: 99 },
        },
      });

      // uploads: explicit config wins (maxUploadSize: 42), not {} from env
      expect(volumes.uploads).toEqual({ maxUploadSize: 42 });
      // exports: discovered from env with default empty config
      expect(volumes.exports).toEqual({});
      // custom: explicit only, no env var
      expect(volumes.custom).toEqual({ maxUploadSize: 99 });
    });

    test("discovered volumes get empty config objects", () => {
      process.env.DATABRICKS_VOLUME_DATA = "/Volumes/catalog/schema/data";

      try {
        const volumes = FilesPlugin.discoverVolumes({});
        expect(volumes.data).toEqual({});
      } finally {
        delete process.env.DATABRICKS_VOLUME_DATA;
      }
    });

    test("explicit volumes without env vars still appear", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;

      const volumes = FilesPlugin.discoverVolumes({
        volumes: {
          private: { maxUploadSize: 10 },
        },
      });

      expect(Object.keys(volumes)).toEqual(["private"]);
      expect(volumes.private).toEqual({ maxUploadSize: 10 });
    });

    test("env var volume is not added when explicit config has the same key", () => {
      process.env.DATABRICKS_VOLUME_SPECIAL = "/Volumes/catalog/schema/special";

      try {
        const volumes = FilesPlugin.discoverVolumes({
          volumes: {
            special: { maxUploadSize: 500 },
          },
        });

        // Explicit wins; should not be overwritten with {}
        expect(volumes.special).toEqual({ maxUploadSize: 500 });
      } finally {
        delete process.env.DATABRICKS_VOLUME_SPECIAL;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 10. Path validation edge cases
  // ──────────────────────────────────────────────────────────────────────
  describe("Path validation", () => {
    test("path with null bytes returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/read");
      const res = mockRes();

      await handler(
        mockReq("uploads", { query: { path: "/Volumes/test/\0evil" } }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "path must not contain null bytes",
        }),
      );
    });

    test("path exceeding 4096 characters returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/read");
      const res = mockRes();

      const longPath = "/Volumes/test/" + "a".repeat(4100);

      await handler(mockReq("uploads", { query: { path: longPath } }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining("exceeds maximum length"),
        }),
      );
    });

    test("exists without path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/exists");
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

    test("metadata without path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/metadata");
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

    test("preview without path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "get", "/preview");
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

    test("upload without path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "post", "/upload");
      const res = mockRes();

      const req = mockUploadReq("uploads", [Buffer.from("data")], {
        query: {},
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "path is required",
          plugin: "files",
        }),
      );
    });

    test("delete with null bytes in path returns 400", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const handler = getRouteHandler(plugin, "delete", "");
      const res = mockRes();

      await handler(
        mockReq("uploads", { query: { path: "/Volumes/test/\0evil" } }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "path must not contain null bytes",
        }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 11. clientConfig returns volume keys
  // ──────────────────────────────────────────────────────────────────────
  describe("clientConfig", () => {
    test("returns configured volume keys", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const config = plugin.clientConfig();

      expect(config).toEqual({ volumes: ["uploads", "exports"] });
    });

    test("returns empty volumes when none configured and no env vars", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;

      const plugin = new FilesPlugin({ volumes: {} });
      const config = plugin.clientConfig();

      expect(config).toEqual({ volumes: [] });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 12. _sendStatusError uses HTTP status code text
  // ──────────────────────────────────────────────────────────────────────
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
