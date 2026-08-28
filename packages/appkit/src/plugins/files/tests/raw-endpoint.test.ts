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

describe("FilesPlugin raw endpoint security headers", () => {
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

  test("raw endpoint sets CSP sandbox header", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/raw");
    const res = mockRes();

    getMock(client, "files.download").mockResolvedValue(
      makeStreamResponse("data"),
    );

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

    getMock(client, "files.download").mockResolvedValue(
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

    const dispositionCalls = res.setHeader.mock.calls.filter(
      (c: string[]) => c[0] === "Content-Disposition",
    );
    expect(dispositionCalls).toHaveLength(0);
  });

  test("raw endpoint with unsafe content type (text/html) forces download", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const handler = getRouteHandler(plugin, "get", "/raw");
    const res = mockRes();

    getMock(client, "files.download").mockResolvedValue(
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

    getMock(client, "files.download").mockResolvedValue(
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

    getMock(client, "files.download").mockResolvedValue(
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
