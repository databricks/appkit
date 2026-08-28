import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createMockWorkspaceClient, getMock } from "../../../testing";
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

const { mockCacheInstance } = await vi.hoisted(async () => {
  const { createCacheMock } = await import("../../../testing/cache-mock");
  return { mockCacheInstance: createCacheMock() };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin download endpoint Content-Disposition", () => {
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

  test("download sets Content-Disposition: attachment with filename", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/download");
    const res = mockRes();

    getMock(client, "files.download").mockResolvedValue(
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

    getMock(client, "files.download").mockResolvedValue(
      makeStreamResponse("data"),
    );

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

    getMock(client, "files.download").mockResolvedValue(
      makeStreamResponse("{}"),
    );

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
    getMock(client, "files.download").mockResolvedValue({});

    await handler(
      mockReq("uploads", {
        query: { path: "/Volumes/catalog/schema/uploads/empty.txt" },
      }),
      res,
    );

    expect(res.end).toHaveBeenCalled();
  });
});
