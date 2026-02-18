import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { contentTypeFromPath } from "../helpers";
import { FilesClient } from "../lib";
import { FilesPlugin, files } from "../plugin";

// ---------------------------------------------------------------------------
// Mock SDK + CacheManager
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helper: create a ReadableStream from a string
// ---------------------------------------------------------------------------
function streamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contentTypeFromPath", () => {
  test("returns reported content-type when not application/octet-stream", () => {
    expect(contentTypeFromPath("/file.txt", "text/html")).toBe("text/html");
  });

  test("falls back to extension lookup when reported is application/octet-stream", () => {
    expect(contentTypeFromPath("/image.png", "application/octet-stream")).toBe(
      "image/png",
    );
  });

  test("falls back to extension lookup when no reported type", () => {
    expect(contentTypeFromPath("/data.json")).toBe("application/json");
  });

  test("returns application/octet-stream for unknown extensions with no reported type", () => {
    expect(contentTypeFromPath("/file.xyz")).toBe("application/octet-stream");
  });

  test("handles case-insensitive extensions", () => {
    expect(contentTypeFromPath("/image.PNG")).toBe("image/png");
    expect(contentTypeFromPath("/data.Json")).toBe("application/json");
  });
});

describe("FilesClient - Path Resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("absolute paths are returned as-is", () => {
    const client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });

    // Exercise resolvePath indirectly via download
    mockFilesApi.download.mockResolvedValue({ contents: null });
    client.download("/Volumes/other/path/file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/other/path/file.txt",
    });
  });

  test("relative paths prepend defaultVolume", () => {
    const client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });

    mockFilesApi.download.mockResolvedValue({ contents: null });
    client.download("subdir/file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol/subdir/file.txt",
    });
  });

  test("relative path without defaultVolume throws error", () => {
    const client = new FilesClient({ client: mockClient as any });

    expect(() => client.download("file.txt")).rejects.toThrow(
      "Cannot resolve relative path",
    );
  });

  test("volume() creates new client scoped to a different volume", () => {
    const client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol1",
      client: mockClient as any,
    });

    const scoped = client.volume("/Volumes/catalog/schema/vol2");

    mockFilesApi.download.mockResolvedValue({ contents: null });
    scoped.download("file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol2/file.txt",
    });
  });
});

describe("FilesClient - Core Operations", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  describe("list()", () => {
    test("collects async iterator entries", async () => {
      const entries = [
        {
          name: "file1.txt",
          path: "/Volumes/catalog/schema/vol/file1.txt",
          is_directory: false,
        },
        {
          name: "subdir",
          path: "/Volumes/catalog/schema/vol/subdir",
          is_directory: true,
        },
      ];

      mockFilesApi.listDirectoryContents.mockReturnValue(
        (async function* () {
          for (const entry of entries) {
            yield entry;
          }
        })(),
      );

      const result = await client.list();

      expect(result).toEqual(entries);
      expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
        directory_path: "/Volumes/catalog/schema/vol",
      });
    });

    test("uses defaultVolume when no path provided", async () => {
      mockFilesApi.listDirectoryContents.mockReturnValue(
        (async function* () {})(),
      );

      await client.list();

      expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
        directory_path: "/Volumes/catalog/schema/vol",
      });
    });

    test("throws when no path and no defaultVolume", async () => {
      const noVolumeClient = new FilesClient({ client: mockClient as any });

      await expect(noVolumeClient.list()).rejects.toThrow(
        "No directory path provided and no default volume set.",
      );
    });

    test("uses provided path when given", async () => {
      mockFilesApi.listDirectoryContents.mockReturnValue(
        (async function* () {})(),
      );

      await client.list("/Volumes/other/path");

      expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
        directory_path: "/Volumes/other/path",
      });
    });
  });

  describe("read()", () => {
    test("decodes ReadableStream to UTF-8 string", async () => {
      const content = "Hello, world!";
      mockFilesApi.download.mockResolvedValue({
        contents: streamFromString(content),
      });

      const result = await client.read("/file.txt");

      expect(result).toBe(content);
    });

    test("returns empty string for no contents", async () => {
      mockFilesApi.download.mockResolvedValue({ contents: null });

      const result = await client.read("/empty.txt");

      expect(result).toBe("");
    });
  });

  describe("download()", () => {
    test("calls client.files.download with resolved path", async () => {
      const response = { contents: streamFromString("data") };
      mockFilesApi.download.mockResolvedValue(response);

      const result = await client.download("file.txt");

      expect(mockFilesApi.download).toHaveBeenCalledWith({
        file_path: "/Volumes/catalog/schema/vol/file.txt",
      });
      expect(result).toBe(response);
    });
  });

  describe("exists()", () => {
    test("returns true when metadata succeeds", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 100,
        "content-type": "text/plain",
        "last-modified": "2025-01-01",
      });

      const result = await client.exists("/file.txt");

      expect(result).toBe(true);
    });

    test("returns false on 404 ApiError", async () => {
      mockFilesApi.getMetadata.mockRejectedValue(
        new MockApiError("Not found", 404),
      );

      const result = await client.exists("/missing.txt");

      expect(result).toBe(false);
    });

    test("rethrows other errors", async () => {
      mockFilesApi.getMetadata.mockRejectedValue(
        new MockApiError("Server error", 500),
      );

      await expect(client.exists("/file.txt")).rejects.toThrow("Server error");
    });
  });

  describe("metadata()", () => {
    test("maps SDK response to FileMetadata", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 1234,
        "content-type": "application/json",
        "last-modified": "2025-06-15T10:00:00Z",
      });

      const result = await client.metadata("/data.json");

      expect(result).toEqual({
        contentLength: 1234,
        contentType: "application/json",
        lastModified: "2025-06-15T10:00:00Z",
      });
    });

    test("uses contentTypeFromPath for content-type", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 500,
        "content-type": "application/octet-stream",
        "last-modified": "2025-01-01",
      });

      const result = await client.metadata("/image.png");

      expect(result.contentType).toBe("image/png");
    });
  });

  describe("upload()", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockClient.config.authenticate.mockResolvedValue(undefined);
      fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test("handles string input", async () => {
      await client.upload("file.txt", "hello world");

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/2.0/fs/files/Volumes/catalog/schema/vol/file.txt",
        ),
        expect.objectContaining({
          method: "PUT",
          body: "hello world",
        }),
      );
    });

    test("handles Buffer input", async () => {
      const buf = Buffer.from("buffer data");
      await client.upload("file.bin", buf);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PUT",
          body: buf,
        }),
      );
    });

    test("handles ReadableStream input", async () => {
      const stream = streamFromString("stream data");
      await client.upload("file.txt", stream);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PUT",
          body: expect.any(ReadableStream),
          duplex: "half",
        }),
      );
    });

    test("sets overwrite param", async () => {
      await client.upload("file.txt", "data", { overwrite: false });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("overwrite=false");
    });

    test("defaults overwrite to true", async () => {
      await client.upload("file.txt", "data");

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("overwrite=true");
    });

    test("throws on non-ok response", async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      await expect(client.upload("file.txt", "data")).rejects.toThrow(
        "Upload failed (403): Forbidden",
      );
    });
  });

  describe("createDirectory()", () => {
    test("calls client.files.createDirectory", async () => {
      mockFilesApi.createDirectory.mockResolvedValue(undefined);

      await client.createDirectory("new-dir");

      expect(mockFilesApi.createDirectory).toHaveBeenCalledWith({
        directory_path: "/Volumes/catalog/schema/vol/new-dir",
      });
    });
  });

  describe("delete()", () => {
    test("calls client.files.delete", async () => {
      mockFilesApi.delete.mockResolvedValue(undefined);

      await client.delete("file.txt");

      expect(mockFilesApi.delete).toHaveBeenCalledWith({
        file_path: "/Volumes/catalog/schema/vol/file.txt",
      });
    });
  });
});

describe("FilesClient - Preview", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  test("text files return truncated preview (max 1024 bytes)", async () => {
    const longText = "A".repeat(2000);

    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 2000,
      "content-type": "text/plain",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString(longText),
    });

    const result = await client.preview("/file.txt");

    expect(result.isText).toBe(true);
    expect(result.isImage).toBe(false);
    expect(result.textPreview).not.toBeNull();
    expect(result.textPreview!.length).toBeLessThanOrEqual(1024);
  });

  test("application/json files are treated as text", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 20,
      "content-type": "application/json",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString('{"key":"value"}'),
    });

    const result = await client.preview("/data.json");

    expect(result.isText).toBe(true);
    expect(result.textPreview).toBe('{"key":"value"}');
  });

  test("application/xml files are treated as text", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 30,
      "content-type": "application/xml",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString("<root/>"),
    });

    const result = await client.preview("/data.xml");

    expect(result.isText).toBe(true);
    expect(result.textPreview).toBe("<root/>");
  });

  test("image files return isImage: true, textPreview: null", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 5000,
      "content-type": "image/png",
      "last-modified": "2025-01-01",
    });

    const result = await client.preview("/image.png");

    expect(result.isImage).toBe(true);
    expect(result.isText).toBe(false);
    expect(result.textPreview).toBeNull();
  });

  test("other files return isText: false, isImage: false, textPreview: null", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 1000,
      "content-type": "application/pdf",
      "last-modified": "2025-01-01",
    });

    const result = await client.preview("/doc.pdf");

    expect(result.isText).toBe(false);
    expect(result.isImage).toBe(false);
    expect(result.textPreview).toBeNull();
  });

  test("empty file contents return empty string preview", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 0,
      "content-type": "text/plain",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: null,
    });

    const result = await client.preview("/empty.txt");

    expect(result.isText).toBe(true);
    expect(result.textPreview).toBe("");
  });
});

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

    // All exports should be functions
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

    // 8 GET routes: root, list, read, download, raw, exists, metadata, preview
    expect(mockRouter.get).toHaveBeenCalledTimes(8);
    // 3 POST routes: upload, mkdir, delete
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
