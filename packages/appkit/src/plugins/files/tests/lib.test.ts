import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { contentTypeFromPath } from "../helpers";
import { FilesClient } from "../lib";

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------
const { mockFilesApi, mockClient, MockApiError } = vi.hoisted(() => {
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

  return { mockFilesApi, mockClient, MockApiError };
});

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => mockClient),
  ApiError: MockApiError,
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

// Creates a ReadableStream that yields multiple chunks
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// =========================================================================
// contentTypeFromPath
// =========================================================================
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

  test("uses extension when reported is undefined", () => {
    expect(contentTypeFromPath("/style.css", undefined)).toBe("text/css");
  });

  test("returns reported type for known extensions when reported differs", () => {
    // If the server says it's text/html, trust it even for a .json file
    expect(contentTypeFromPath("/file.json", "text/html")).toBe("text/html");
  });

  test("handles paths with multiple dots", () => {
    expect(contentTypeFromPath("/archive.tar.gz")).toBe(
      "application/octet-stream",
    );
    expect(contentTypeFromPath("/data.backup.json")).toBe("application/json");
  });
});

// =========================================================================
// FilesClient – Path Resolution
// =========================================================================
describe("FilesClient – Path Resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("absolute paths are returned as-is", () => {
    const client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });

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

  test("relative path without defaultVolume throws error", async () => {
    const client = new FilesClient({ client: mockClient as any });

    await expect(client.download("file.txt")).rejects.toThrow(
      "Cannot resolve relative path: no default volume set.",
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

  test("volume() does not affect the original client", () => {
    const client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol1",
      client: mockClient as any,
    });

    client.volume("/Volumes/catalog/schema/vol2");

    mockFilesApi.download.mockResolvedValue({ contents: null });
    client.download("file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol1/file.txt",
    });
  });

  test("constructor without defaultVolume omits it", async () => {
    const client = new FilesClient({ client: mockClient as any });

    await expect(client.list()).rejects.toThrow(
      "No directory path provided and no default volume set.",
    );
  });
});

// =========================================================================
// FilesClient – list()
// =========================================================================
describe("FilesClient – list()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

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

  test("uses provided absolute path", async () => {
    mockFilesApi.listDirectoryContents.mockReturnValue(
      (async function* () {})(),
    );

    await client.list("/Volumes/other/path");

    expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
      directory_path: "/Volumes/other/path",
    });
  });

  test("resolves relative path with defaultVolume", async () => {
    mockFilesApi.listDirectoryContents.mockReturnValue(
      (async function* () {})(),
    );

    await client.list("subdir");

    expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
      directory_path: "/Volumes/catalog/schema/vol/subdir",
    });
  });

  test("returns empty array for empty directory", async () => {
    mockFilesApi.listDirectoryContents.mockReturnValue(
      (async function* () {})(),
    );

    const result = await client.list();

    expect(result).toEqual([]);
  });
});

// =========================================================================
// FilesClient – read()
// =========================================================================
describe("FilesClient – read()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  test("decodes ReadableStream to UTF-8 string", async () => {
    const content = "Hello, world!";
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString(content),
    });

    const result = await client.read("/file.txt");

    expect(result).toBe(content);
  });

  test("returns empty string when contents is null", async () => {
    mockFilesApi.download.mockResolvedValue({ contents: null });

    const result = await client.read("/empty.txt");

    expect(result).toBe("");
  });

  test("concatenates multiple chunks correctly", async () => {
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromChunks(["Hello, ", "world", "!"]),
    });

    const result = await client.read("/chunked.txt");

    expect(result).toBe("Hello, world!");
  });

  test("handles multi-byte UTF-8 characters", async () => {
    const content = "Héllo wörld 🌍";
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString(content),
    });

    const result = await client.read("/unicode.txt");

    expect(result).toBe(content);
  });
});

// =========================================================================
// FilesClient – download()
// =========================================================================
describe("FilesClient – download()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  test("calls client.files.download with resolved path", async () => {
    const response = { contents: streamFromString("data") };
    mockFilesApi.download.mockResolvedValue(response);

    const result = await client.download("file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol/file.txt",
    });
    expect(result).toBe(response);
  });

  test("passes absolute path directly", async () => {
    const response = { contents: null };
    mockFilesApi.download.mockResolvedValue(response);

    await client.download("/Volumes/other/file.txt");

    expect(mockFilesApi.download).toHaveBeenCalledWith({
      file_path: "/Volumes/other/file.txt",
    });
  });
});

// =========================================================================
// FilesClient – exists()
// =========================================================================
describe("FilesClient – exists()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

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

  test("rethrows non-404 ApiError", async () => {
    mockFilesApi.getMetadata.mockRejectedValue(
      new MockApiError("Server error", 500),
    );

    await expect(client.exists("/file.txt")).rejects.toThrow("Server error");
  });

  test("rethrows generic errors", async () => {
    mockFilesApi.getMetadata.mockRejectedValue(new Error("Network failure"));

    await expect(client.exists("/file.txt")).rejects.toThrow("Network failure");
  });
});

// =========================================================================
// FilesClient – metadata()
// =========================================================================
describe("FilesClient – metadata()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

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

  test("uses contentTypeFromPath to resolve octet-stream", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 500,
      "content-type": "application/octet-stream",
      "last-modified": "2025-01-01",
    });

    const result = await client.metadata("/image.png");

    expect(result.contentType).toBe("image/png");
  });

  test("handles undefined content-type from SDK", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 100,
      "content-type": undefined,
      "last-modified": "2025-01-01",
    });

    const result = await client.metadata("/data.csv");

    expect(result.contentType).toBe("text/csv");
  });

  test("resolves relative path via defaultVolume", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 0,
      "content-type": "text/plain",
      "last-modified": "2025-01-01",
    });

    await client.metadata("notes.txt");

    expect(mockFilesApi.getMetadata).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol/notes.txt",
    });
  });
});

// =========================================================================
// FilesClient – upload()
// =========================================================================
describe("FilesClient – upload()", () => {
  let client: FilesClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
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

  test("handles ReadableStream input (converts to Buffer)", async () => {
    const stream = streamFromString("stream data");
    await client.upload("file.txt", stream);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "PUT",
        body: expect.any(Buffer),
      }),
    );

    // Verify the Buffer content is correct
    const callBody = fetchSpy.mock.calls[0][1].body as Buffer;
    expect(callBody.toString()).toBe("stream data");
  });

  test("defaults overwrite to true", async () => {
    await client.upload("file.txt", "data");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("overwrite=true");
  });

  test("sets overwrite=false when specified", async () => {
    await client.upload("file.txt", "data", { overwrite: false });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("overwrite=false");
  });

  test("calls config.authenticate on the headers", async () => {
    await client.upload("file.txt", "data");

    expect(mockClient.config.authenticate).toHaveBeenCalledWith(
      expect.any(Headers),
    );
  });

  test("builds URL from client.config.host", async () => {
    await client.upload("file.txt", "data");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toMatch(
      /^https:\/\/test\.databricks\.com\/api\/2\.0\/fs\/files/,
    );
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

  test("resolves absolute paths directly", async () => {
    await client.upload("/Volumes/other/vol/file.txt", "data");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/2.0/fs/files/Volumes/other/vol/file.txt");
  });
});

// =========================================================================
// FilesClient – createDirectory()
// =========================================================================
describe("FilesClient – createDirectory()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  test("calls client.files.createDirectory with resolved path", async () => {
    mockFilesApi.createDirectory.mockResolvedValue(undefined);

    await client.createDirectory("new-dir");

    expect(mockFilesApi.createDirectory).toHaveBeenCalledWith({
      directory_path: "/Volumes/catalog/schema/vol/new-dir",
    });
  });

  test("uses absolute path when provided", async () => {
    mockFilesApi.createDirectory.mockResolvedValue(undefined);

    await client.createDirectory("/Volumes/other/path/new-dir");

    expect(mockFilesApi.createDirectory).toHaveBeenCalledWith({
      directory_path: "/Volumes/other/path/new-dir",
    });
  });
});

// =========================================================================
// FilesClient – delete()
// =========================================================================
describe("FilesClient – delete()", () => {
  let client: FilesClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FilesClient({
      defaultVolume: "/Volumes/catalog/schema/vol",
      client: mockClient as any,
    });
  });

  test("calls client.files.delete with resolved path", async () => {
    mockFilesApi.delete.mockResolvedValue(undefined);

    await client.delete("file.txt");

    expect(mockFilesApi.delete).toHaveBeenCalledWith({
      file_path: "/Volumes/catalog/schema/vol/file.txt",
    });
  });

  test("uses absolute path when provided", async () => {
    mockFilesApi.delete.mockResolvedValue(undefined);

    await client.delete("/Volumes/other/file.txt");

    expect(mockFilesApi.delete).toHaveBeenCalledWith({
      file_path: "/Volumes/other/file.txt",
    });
  });
});

// =========================================================================
// FilesClient – preview()
// =========================================================================
describe("FilesClient – preview()", () => {
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

  test("text/html files are treated as text", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 30,
      "content-type": "text/html",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString("<h1>Hello</h1>"),
    });

    const result = await client.preview("/page.html");

    expect(result.isText).toBe(true);
    expect(result.textPreview).toBe("<h1>Hello</h1>");
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
    expect(result.isImage).toBe(false);
    expect(result.textPreview).toBe("");
  });

  test("preview spreads metadata into result", async () => {
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": 42,
      "content-type": "text/plain",
      "last-modified": "2025-06-15T10:00:00Z",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString("hello"),
    });

    const result = await client.preview("/notes.txt");

    expect(result.contentLength).toBe(42);
    expect(result.contentType).toBe("text/plain");
    expect(result.lastModified).toBe("2025-06-15T10:00:00Z");
    expect(result.textPreview).toBe("hello");
  });

  test("short text file returns full content", async () => {
    const content = "Short file.";
    mockFilesApi.getMetadata.mockResolvedValue({
      "content-length": content.length,
      "content-type": "text/plain",
      "last-modified": "2025-01-01",
    });
    mockFilesApi.download.mockResolvedValue({
      contents: streamFromString(content),
    });

    const result = await client.preview("/short.txt");

    expect(result.textPreview).toBe(content);
  });
});
