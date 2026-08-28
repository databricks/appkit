import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createMockWorkspaceClient, getMock } from "../../../testing";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
  mockReq,
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

describe("FilesPlugin path validation", () => {
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

  // Defends against regressions where the handler calls the SDK and *also*
  // returns 400 — the status assertion alone wouldn't catch that.
  function expectNoSdkCall() {
    expect(getMock(client, "files.download")).not.toHaveBeenCalled();
    expect(getMock(client, "files.upload")).not.toHaveBeenCalled();
    expect(getMock(client, "files.delete")).not.toHaveBeenCalled();
    expect(getMock(client, "files.createDirectory")).not.toHaveBeenCalled();
    expect(getMock(client, "files.getMetadata")).not.toHaveBeenCalled();
    expect(
      getMock(client, "files.listDirectoryContents"),
    ).not.toHaveBeenCalled();
  }

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
    expectNoSdkCall();
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
    expectNoSdkCall();
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
    expectNoSdkCall();
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
    expectNoSdkCall();
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
    expectNoSdkCall();
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
    expectNoSdkCall();
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
    expectNoSdkCall();
  });
});
