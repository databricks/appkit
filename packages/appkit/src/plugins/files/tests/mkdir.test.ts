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

// EXPERIMENT: no vi.mock of `../../../workspace-client` or `../../../context`.
// The client is the kit's, injected through the real ServiceContext, and the
// SDK error is a genuine ApiError rather than a look-alike class that only
// passes `instanceof` because the module was patched.
const { mockCacheInstance } = await vi.hoisted(async () => {
  const { createCacheMock } = await import("../../../testing/cache-mock");
  return { mockCacheInstance: createCacheMock() };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin mkdir", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;
  let client: ReturnType<typeof createMockWorkspaceClient>;

  beforeEach(async () => {
    // strict: true keeps the loudness the hand-rolled literal had by accident —
    // an undeclared data-plane call throws instead of resolving undefined.
    client = createMockWorkspaceClient({
      strict: true,
      responses: { "files.createDirectory": undefined },
    });
    serviceContextMock = await setupTestEnv(client);
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  test("successful mkdir invalidates list cache", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "post", "/mkdir");
    const res = mockRes();

    await handler(
      mockReq("uploads", {
        body: { path: "/Volumes/catalog/schema/uploads/newdir" },
      }),
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(getMock(client, "files.createDirectory")).toHaveBeenCalled();
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

    getMock(client, "files.createDirectory").mockRejectedValue(
      createApiError({
        statusCode: 409,
        message: "Conflict",
        errorCode: "ALREADY_EXISTS",
      }),
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
