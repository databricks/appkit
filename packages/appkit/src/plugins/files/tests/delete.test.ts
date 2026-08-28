import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createApiError,
  createMockWorkspaceClient,
  getMock,
} from "../../../testing";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
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

describe("FilesPlugin delete", () => {
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

  test("successful delete invalidates list cache", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "delete", "");
    const res = mockRes();

    getMock(client, "files.delete").mockResolvedValue(undefined);

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

    getMock(client, "files.delete").mockRejectedValue(
      createApiError({
        statusCode: 404,
        message: "Not found",
        errorCode: "ERROR",
      }),
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
