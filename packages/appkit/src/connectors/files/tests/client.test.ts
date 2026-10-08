import { createMockTelemetry } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createApiError } from "../../../testing";
import type { WorkspaceClient } from "../../../workspace-client";
import { ApiError } from "../../../workspace-client";
import { FilesConnector } from "../client";
import { headResponse, streamFromChunks, streamFromString } from "./utils";

const { mockFilesApi, mockConfig, mockClient } = vi.hoisted(() => {
  const mockFilesApi = {
    listDirectoryContentsIter: vi.fn(),
    downloadFile: vi.fn(),
    upload: vi.fn(),
    createDirectory: vi.fn(),
    deleteFile: vi.fn(),
  };

  const mockConfig = {
    host: "https://test.databricks.com",
    authenticate: vi.fn(),
  };

  const mockApiClient = {
    userAgent: vi.fn(() => "@databricks/appkit/9.9.9"),
  };
  const mockClient = {
    files: mockFilesApi,
    config: mockConfig,
    apiClient: mockApiClient,
  } as unknown as WorkspaceClient;

  return { mockFilesApi, mockConfig, mockClient };
});

vi.mock("../../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../workspace-client")>();
  return {
    ...actual,
    createWorkspaceClient: () => mockClient,
  };
});

const mockTelemetry = createMockTelemetry();

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getProvider: vi.fn(() => mockTelemetry),
  },
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

describe("FilesConnector", () => {
  describe("Path Resolution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    test("absolute paths are returned as-is", () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      mockFilesApi.downloadFile.mockResolvedValue({ contents: null });
      connector.download(mockClient, "/Volumes/other/path/file.txt");

      expect(mockFilesApi.downloadFile).toHaveBeenCalledWith({
        filePath: "/Volumes/other/path/file.txt",
      });
    });

    test("relative paths prepend defaultVolume", () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      mockFilesApi.downloadFile.mockResolvedValue({ contents: null });
      connector.download(mockClient, "subdir/file.txt");

      expect(mockFilesApi.downloadFile).toHaveBeenCalledWith({
        filePath: "/Volumes/catalog/schema/vol/subdir/file.txt",
      });
    });

    test("relative path without defaultVolume throws error", async () => {
      const connector = new FilesConnector({});

      await expect(connector.download(mockClient, "file.txt")).rejects.toThrow(
        "Cannot resolve relative path: no default volume set.",
      );
    });

    test("paths containing '..' are rejected", async () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      await expect(
        connector.download(mockClient, "../../../etc/passwd"),
      ).rejects.toThrow('Path traversal ("../") is not allowed.');
    });

    test("absolute paths containing '..' are rejected", async () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      await expect(
        connector.download(mockClient, "/Volumes/catalog/../other/file.txt"),
      ).rejects.toThrow('Path traversal ("../") is not allowed.');
    });

    test("absolute paths not starting with /Volumes/ are rejected", () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      expect(() => connector.resolvePath("/etc/passwd")).toThrow(
        'Absolute paths must start with "/Volumes/"',
      );
    });

    test("paths containing null bytes are rejected", () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      expect(() => connector.resolvePath("file\0.txt")).toThrow(
        "Path must not contain null bytes",
      );
    });

    test("paths exceeding 4096 characters are rejected", () => {
      const connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });

      const longPath = "a".repeat(4097);
      expect(() => connector.resolvePath(longPath)).toThrow(
        "Path exceeds maximum length of 4096 characters",
      );
    });

    test("constructor without defaultVolume omits it", async () => {
      const connector = new FilesConnector({});

      await expect(connector.list(mockClient)).rejects.toThrow(
        "No directory path provided and no default volume set.",
      );
    });
  });

  describe("list()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("collects async iterator entries, mapped to the snake_case wire shape", async () => {
      mockFilesApi.listDirectoryContentsIter.mockReturnValue(
        (async function* () {
          yield {
            name: "file1.txt",
            path: "/Volumes/catalog/schema/vol/file1.txt",
            isDirectory: false,
            fileSize: 42,
            lastModified: 1700000000000,
          };
          yield {
            name: "subdir",
            path: "/Volumes/catalog/schema/vol/subdir",
            isDirectory: true,
          };
        })(),
      );

      const result = await connector.list(mockClient);

      expect(result).toEqual([
        {
          name: "file1.txt",
          path: "/Volumes/catalog/schema/vol/file1.txt",
          is_directory: false,
          file_size: 42,
          last_modified: 1700000000000,
        },
        {
          name: "subdir",
          path: "/Volumes/catalog/schema/vol/subdir",
          is_directory: true,
        },
      ]);
      expect(mockFilesApi.listDirectoryContentsIter).toHaveBeenCalledWith({
        directoryPath: "/Volumes/catalog/schema/vol",
      });
    });

    test("uses defaultVolume when no path provided", async () => {
      mockFilesApi.listDirectoryContentsIter.mockReturnValue(
        (async function* () {})(),
      );

      await connector.list(mockClient);

      expect(mockFilesApi.listDirectoryContentsIter).toHaveBeenCalledWith({
        directoryPath: "/Volumes/catalog/schema/vol",
      });
    });

    test("throws when no path and no defaultVolume", async () => {
      const noVolumeConnector = new FilesConnector({});

      await expect(noVolumeConnector.list(mockClient)).rejects.toThrow(
        "No directory path provided and no default volume set.",
      );
    });

    test("uses provided absolute path", async () => {
      mockFilesApi.listDirectoryContentsIter.mockReturnValue(
        (async function* () {})(),
      );

      await connector.list(mockClient, "/Volumes/other/path");

      expect(mockFilesApi.listDirectoryContentsIter).toHaveBeenCalledWith({
        directoryPath: "/Volumes/other/path",
      });
    });

    test("resolves relative path with defaultVolume", async () => {
      mockFilesApi.listDirectoryContentsIter.mockReturnValue(
        (async function* () {})(),
      );

      await connector.list(mockClient, "subdir");

      expect(mockFilesApi.listDirectoryContentsIter).toHaveBeenCalledWith({
        directoryPath: "/Volumes/catalog/schema/vol/subdir",
      });
    });

    test("returns empty array for empty directory", async () => {
      mockFilesApi.listDirectoryContentsIter.mockReturnValue(
        (async function* () {})(),
      );

      const result = await connector.list(mockClient);

      expect(result).toEqual([]);
    });
  });

  describe("read()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("decodes ReadableStream to UTF-8 string", async () => {
      const content = "Hello, world!";
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString(content),
      });

      const result = await connector.read(mockClient, "file.txt");

      expect(result).toBe(content);
    });

    test("returns empty string when contents is null", async () => {
      mockFilesApi.downloadFile.mockResolvedValue({ contents: null });

      const result = await connector.read(mockClient, "empty.txt");

      expect(result).toBe("");
    });

    test("concatenates multiple chunks correctly", async () => {
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromChunks(["Hello, ", "world", "!"]),
      });

      const result = await connector.read(mockClient, "chunked.txt");

      expect(result).toBe("Hello, world!");
    });

    test("handles multi-byte UTF-8 characters", async () => {
      const content = "Héllo wörld 🌍";
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString(content),
      });

      const result = await connector.read(mockClient, "unicode.txt");

      expect(result).toBe(content);
    });
  });

  describe("download()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("calls client.files.downloadFile with resolved path", async () => {
      const contents = streamFromString("data");
      mockFilesApi.downloadFile.mockResolvedValue({
        contentLength: 4n,
        contentType: "text/plain",
        lastModified: "Mon, 01 Jan 2025 00:00:00 GMT",
        contents,
      });

      const result = await connector.download(mockClient, "file.txt");

      expect(mockFilesApi.downloadFile).toHaveBeenCalledWith({
        filePath: "/Volumes/catalog/schema/vol/file.txt",
      });
      expect(result).toEqual({
        "content-length": 4,
        "content-type": "text/plain",
        "last-modified": "Mon, 01 Jan 2025 00:00:00 GMT",
        contents,
      });
      expect(result.contents).toBe(contents);
    });

    test("converts a modular-SDK 404 error into the wrapper ApiError", async () => {
      mockFilesApi.downloadFile.mockRejectedValue(
        Object.assign(new Error("File not found"), {
          httpStatusCode: 404,
          code: "NOT_FOUND",
        }),
      );

      const error = await connector
        .download(mockClient, "missing.txt")
        .catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe("NOT_FOUND");
      expect(error.message).toBe("File not found");
    });

    test("passes absolute path directly", async () => {
      const response = { contents: null };
      mockFilesApi.downloadFile.mockResolvedValue(response);

      await connector.download(mockClient, "/Volumes/other/file.txt");

      expect(mockFilesApi.downloadFile).toHaveBeenCalledWith({
        filePath: "/Volumes/other/file.txt",
      });
    });
  });

  describe("exists()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("returns true when metadata succeeds", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 100,
          "content-type": "text/plain",
          "last-modified": "2025-01-01",
        }),
      );

      const result = await connector.exists(mockClient, "file.txt");

      expect(result).toBe(true);
    });

    test("returns false on 404 ApiError", async () => {
      mockRequest.mockRejectedValue(
        createApiError({
          message: "Not found",
          errorCode: "NOT_FOUND",
          statusCode: 404,
        }),
      );

      const result = await connector.exists(mockClient, "missing.txt");

      expect(result).toBe(false);
    });

    test("rethrows non-404 ApiError", async () => {
      mockRequest.mockRejectedValue(
        createApiError({
          message: "Server error",
          errorCode: "SERVER_ERROR",
          statusCode: 500,
        }),
      );

      await expect(connector.exists(mockClient, "file.txt")).rejects.toThrow(
        "Server error",
      );
    });

    test("rethrows generic errors", async () => {
      mockRequest.mockRejectedValue(new Error("Network failure"));

      await expect(connector.exists(mockClient, "file.txt")).rejects.toThrow(
        "Network failure",
      );
    });
  });

  describe("metadata()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("maps SDK response to FileMetadata", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 1234,
          "content-type": "application/json",
          "last-modified": "2025-06-15T10:00:00Z",
        }),
      );

      const result = await connector.metadata(mockClient, "data.json");

      expect(result).toEqual({
        contentLength: 1234,
        contentType: "application/json",
        lastModified: "2025-06-15T10:00:00Z",
      });
    });

    test("uses contentTypeFromPath to resolve octet-stream", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 500,
          "content-type": "application/octet-stream",
          "last-modified": "2025-01-01",
        }),
      );

      const result = await connector.metadata(mockClient, "image.png");

      expect(result.contentType).toBe("image/png");
    });

    test("handles undefined content-type from SDK", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 100,
          "content-type": undefined,
          "last-modified": "2025-01-01",
        }),
      );

      const result = await connector.metadata(mockClient, "data.csv");

      expect(result.contentType).toBe("text/csv");
    });

    test("resolves relative path via defaultVolume", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 0,
          "content-type": "text/plain",
          "last-modified": "2025-01-01",
        }),
      );

      await connector.metadata(mockClient, "notes.txt");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "HEAD",
        path: "/api/2.0/fs/files/Volumes/catalog/schema/vol/notes.txt",
      });
    });

    // Regression: the modular SDK's getFileMetadata drops HEAD response
    // headers, so metadata must come from the raw HEAD response headers.
    test("reads metadata from the HEAD response headers", async () => {
      mockRequest.mockResolvedValue(
        new Response(null, {
          headers: {
            "content-length": "2048",
            "content-type": "text/plain",
            "last-modified": "Sun, 15 Jun 2025 10:00:00 GMT",
          },
        }),
      );

      const result = await connector.metadata(mockClient, "notes.txt");

      expect(result).toEqual({
        contentLength: 2048,
        contentType: "text/plain",
        lastModified: "Sun, 15 Jun 2025 10:00:00 GMT",
      });
    });
  });

  describe("upload()", () => {
    let connector: FilesConnector;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
      mockConfig.authenticate.mockResolvedValue(undefined);
      fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test("handles string input", async () => {
      await connector.upload(mockClient, "file.txt", "hello world");

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
      await connector.upload(mockClient, "file.bin", buf);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PUT",
          body: buf,
        }),
      );
    });

    test("handles ReadableStream input (streams directly)", async () => {
      const stream = streamFromString("stream data");
      await connector.upload(mockClient, "file.txt", stream);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PUT",
          body: expect.any(ReadableStream),
          duplex: "half",
        }),
      );
    });

    test("defaults overwrite to true", async () => {
      await connector.upload(mockClient, "file.txt", "data");

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("overwrite=true");
    });

    test("sets overwrite=false when specified", async () => {
      await connector.upload(mockClient, "file.txt", "data", {
        overwrite: false,
      });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("overwrite=false");
    });

    test("calls config.authenticate on the headers", async () => {
      await connector.upload(mockClient, "file.txt", "data");

      expect(mockConfig.authenticate).toHaveBeenCalledWith(expect.any(Headers));
    });

    test("stamps the AppKit User-Agent from the SDK apiClient", async () => {
      await connector.upload(mockClient, "file.txt", "data");

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Headers;
      expect(headers.get("User-Agent")).toBe("@databricks/appkit/9.9.9");
    });

    test("builds URL from client.config.host", async () => {
      await connector.upload(mockClient, "file.txt", "data");

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toMatch(
        /^https:\/\/test\.databricks\.com\/api\/2\.0\/fs\/files/,
      );
    });

    test("throws ApiError on non-ok response", async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      await expect(
        connector.upload(mockClient, "file.txt", "data"),
      ).rejects.toThrow("Upload failed: Forbidden");

      try {
        await connector.upload(mockClient, "file.txt", "data");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as any).statusCode).toBe(403);
      }
    });

    test("resolves absolute paths directly", async () => {
      await connector.upload(mockClient, "/Volumes/other/vol/file.txt", "data");

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/2.0/fs/files/Volumes/other/vol/file.txt");
    });
  });

  describe("createDirectory()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("calls client.files.createDirectory with resolved path", async () => {
      mockFilesApi.createDirectory.mockResolvedValue(undefined);

      await connector.createDirectory(mockClient, "new-dir");

      expect(mockFilesApi.createDirectory).toHaveBeenCalledWith({
        directoryPath: "/Volumes/catalog/schema/vol/new-dir",
      });
    });

    test("uses absolute path when provided", async () => {
      mockFilesApi.createDirectory.mockResolvedValue(undefined);

      await connector.createDirectory(
        mockClient,
        "/Volumes/other/path/new-dir",
      );

      expect(mockFilesApi.createDirectory).toHaveBeenCalledWith({
        directoryPath: "/Volumes/other/path/new-dir",
      });
    });
  });

  describe("delete()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("calls client.files.deleteFile with resolved path", async () => {
      mockFilesApi.deleteFile.mockResolvedValue(undefined);

      await connector.delete(mockClient, "file.txt");

      expect(mockFilesApi.deleteFile).toHaveBeenCalledWith({
        filePath: "/Volumes/catalog/schema/vol/file.txt",
      });
    });

    test("uses absolute path when provided", async () => {
      mockFilesApi.deleteFile.mockResolvedValue(undefined);

      await connector.delete(mockClient, "/Volumes/other/file.txt");

      expect(mockFilesApi.deleteFile).toHaveBeenCalledWith({
        filePath: "/Volumes/other/file.txt",
      });
    });
  });

  describe("preview()", () => {
    let connector: FilesConnector;

    beforeEach(() => {
      vi.clearAllMocks();
      connector = new FilesConnector({
        defaultVolume: "/Volumes/catalog/schema/vol",
      });
    });

    test("text files return truncated preview (max 1024 chars)", async () => {
      const longText = "A".repeat(2000);

      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 2000,
          "content-type": "text/plain",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString(longText),
      });

      const result = await connector.preview(mockClient, "file.txt");

      expect(result.isText).toBe(true);
      expect(result.isImage).toBe(false);
      expect(result.textPreview).not.toBeNull();
      expect(result.textPreview?.length).toBeLessThanOrEqual(1024);
    });

    test("text/html files are treated as text", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 30,
          "content-type": "text/html",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString("<h1>Hello</h1>"),
      });

      const result = await connector.preview(mockClient, "page.html");

      expect(result.isText).toBe(true);
      expect(result.textPreview).toBe("<h1>Hello</h1>");
    });

    test("application/json files are treated as text", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 20,
          "content-type": "application/json",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString('{"key":"value"}'),
      });

      const result = await connector.preview(mockClient, "data.json");

      expect(result.isText).toBe(true);
      expect(result.textPreview).toBe('{"key":"value"}');
    });

    test("application/xml files are treated as text", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 30,
          "content-type": "application/xml",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString("<root/>"),
      });

      const result = await connector.preview(mockClient, "data.xml");

      expect(result.isText).toBe(true);
      expect(result.textPreview).toBe("<root/>");
    });

    test("image files return isImage: true, textPreview: null", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 5000,
          "content-type": "image/png",
          "last-modified": "2025-01-01",
        }),
      );

      const result = await connector.preview(mockClient, "image.png");

      expect(result.isImage).toBe(true);
      expect(result.isText).toBe(false);
      expect(result.textPreview).toBeNull();
    });

    test("other files return isText: false, isImage: false, textPreview: null", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 1000,
          "content-type": "application/pdf",
          "last-modified": "2025-01-01",
        }),
      );

      const result = await connector.preview(mockClient, "doc.pdf");

      expect(result.isText).toBe(false);
      expect(result.isImage).toBe(false);
      expect(result.textPreview).toBeNull();
    });

    test("empty file contents return empty string preview", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 0,
          "content-type": "text/plain",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: null,
      });

      const result = await connector.preview(mockClient, "empty.txt");

      expect(result.isText).toBe(true);
      expect(result.isImage).toBe(false);
      expect(result.textPreview).toBe("");
    });

    test("preview spreads metadata into result", async () => {
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": 42,
          "content-type": "text/plain",
          "last-modified": "2025-06-15T10:00:00Z",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString("hello"),
      });

      const result = await connector.preview(mockClient, "notes.txt");

      expect(result.contentLength).toBe(42);
      expect(result.contentType).toBe("text/plain");
      expect(result.lastModified).toBe("2025-06-15T10:00:00Z");
      expect(result.textPreview).toBe("hello");
    });

    test("short text file returns full content", async () => {
      const content = "Short file.";
      mockRequest.mockResolvedValue(
        headResponse({
          "content-length": content.length,
          "content-type": "text/plain",
          "last-modified": "2025-01-01",
        }),
      );
      mockFilesApi.downloadFile.mockResolvedValue({
        contents: streamFromString(content),
      });

      const result = await connector.preview(mockClient, "short.txt");

      expect(result.textPreview).toBe(content);
    });
  });
});
