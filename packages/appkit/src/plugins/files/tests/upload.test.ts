import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createMockWorkspaceClient } from "../../../testing";
import { FilesPlugin } from "../plugin";
import { policy } from "../policy";
import {
  getRouteHandler,
  mockRes,
  mockUploadReq,
  setupTestEnv,
  teardownTestEnv,
  VOLUMES_CONFIG,
} from "./_test-helpers";

const { mockCacheInstance } = await vi.hoisted(async () => {
  const { createCacheMock } = await import("../../../testing/cache-mock");
  return { mockCacheInstance: createCacheMock() };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin upload", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  let client: ReturnType<typeof createMockWorkspaceClient>;

  beforeEach(async () => {
    client = createMockWorkspaceClient({
      strict: true,
      responses: {
        "files.listDirectoryContents": undefined,
        "files.download": undefined,
        "files.getMetadata": undefined,
        "files.upload": undefined,
        "files.createDirectory": undefined,
        "files.delete": undefined,
      },
    });
    serviceContextMock = await setupTestEnv(client);
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

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
      expect(mockCacheInstance.generateKey).toHaveBeenCalled();
      expect(mockCacheInstance.delete).toHaveBeenCalled();
    });
  });
});
