import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createApiError,
  createMockWorkspaceClient,
  getMock,
  useTestCache,
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

// Real in-memory cache; spy on `testCache.current` to assert the plugin's
// cache-invalidation calls.
const testCache = useTestCache();

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

    const generateKey = vi.spyOn(testCache.current, "generateKey");
    const del = vi.spyOn(testCache.current, "delete");

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
    expect(generateKey).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
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
