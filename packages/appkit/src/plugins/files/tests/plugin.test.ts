import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { FilesPlugin, files } from "../plugin";
import { streamFromString } from "./utils";

const { mockFilesApi, mockClient, MockApiError, mockCacheInstance } =
  vi.hoisted(() => {
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

vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => mockClient),
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
  });

  test('plugin name is "files"', () => {
    const pluginData = files({ defaultVolume: "/Volumes/test" });
    expect(pluginData.name).toBe("files");
  });

  test("plugin instance has correct name", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    expect(plugin.name).toBe("files");
  });

  test("exports() returns all expected methods", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const exported = plugin.exports();

    expect(exported).toHaveProperty("list");
    expect(exported).toHaveProperty("read");
    expect(exported).toHaveProperty("download");
    expect(exported).toHaveProperty("exists");
    expect(exported).toHaveProperty("metadata");
    expect(exported).toHaveProperty("upload");
    expect(exported).toHaveProperty("createDirectory");
    expect(exported).toHaveProperty("delete");
    expect(exported).toHaveProperty("preview");

    for (const value of Object.values(exported)) {
      expect(typeof value).toBe("function");
    }
  });

  test("injectRoutes registers GET and POST routes", () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const mockRouter = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    } as any;

    plugin.injectRoutes(mockRouter);

    // 8 GET routes
    // root, list, read, download, raw, exists, metadata, preview
    expect(mockRouter.get).toHaveBeenCalledTimes(8);
    // 3 POST routes:
    // upload, mkdir, delete
    expect(mockRouter.post).toHaveBeenCalledTimes(3);
    expect(mockRouter.put).not.toHaveBeenCalled();
    expect(mockRouter.patch).not.toHaveBeenCalled();
  });

  test("shutdown() calls streamManager.abortAll()", async () => {
    const plugin = new FilesPlugin({ defaultVolume: "/Volumes/test" });
    const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

    await plugin.shutdown();

    expect(abortAllSpy).toHaveBeenCalled();
  });
});
