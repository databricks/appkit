import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  filesPlugin,
  getRouteHandler,
  mockReq,
  mockRes,
  setupTestEnv,
  teardownTestEnv,
  testCache,
} from "./_test-helpers";

const { mockClient, MockApiError } = vi.hoisted(() => {
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
  return { mockClient, MockApiError };
});

vi.mock("../../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../workspace-client")>();
  return {
    ...actual,
    createWorkspaceClient: (..._args: unknown[]) => mockClient,
    ApiError: MockApiError,
  };
});

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return {
    ...actual,
    getWorkspaceClient: vi.fn(() => mockClient),
    isInUserContext: vi.fn(() => true),
  };
});

describe("FilesPlugin delete", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  beforeEach(async () => {
    serviceContextMock = await setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  test("successful delete invalidates list cache", async () => {
    const plugin = filesPlugin();
    const handler = getRouteHandler(plugin, "delete", "");
    const res = mockRes();
    // Production's own keying and invalidation, not a fake's.
    const generateKey = vi.spyOn(testCache, "generateKey");
    const invalidate = vi.spyOn(testCache, "delete");

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
    expect(generateKey).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  });

  test("delete without path returns 400", async () => {
    const plugin = filesPlugin();
    const handler = getRouteHandler(plugin, "delete", "");
    const res = mockRes();

    await handler(mockReq("uploads", { query: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "path is required" }),
    );
  });

  test("delete that throws ApiError returns proper status", async () => {
    const plugin = filesPlugin();
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
