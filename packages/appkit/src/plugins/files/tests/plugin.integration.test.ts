import type { Server } from "node:http";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { server as serverPlugin } from "../../server";
import { files } from "../index";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockFilesApi, mockSdkClient, MockApiError } = vi.hoisted(() => {
  const mockFilesApi = {
    listDirectoryContents: vi.fn(),
    download: vi.fn(),
    getMetadata: vi.fn(),
    upload: vi.fn(),
    createDirectory: vi.fn(),
    delete: vi.fn(),
  };

  const mockSdkClient = {
    files: mockFilesApi,
    config: {
      host: "https://test.databricks.com",
      authenticate: vi.fn(),
    },
    currentUser: {
      me: vi.fn().mockResolvedValue({ id: "test-user" }),
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

  return { mockFilesApi, mockSdkClient, MockApiError };
});

// Mock SDK so `ApiError` instanceof checks work in FilesClient.exists()
vi.mock("@databricks/sdk-experimental", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@databricks/sdk-experimental")>();
  return {
    ...actual,
    ApiError: MockApiError,
  };
});

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

// Headers to simulate authenticated user requests (required by asUser)
const authHeaders = {
  "x-forwarded-access-token": "test-token",
  "x-forwarded-user": "test-user",
};

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------
describe("Files Plugin Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9877;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();

    serviceContextMock = await mockServiceContext({
      serviceDatabricksClient: mockSdkClient,
      userDatabricksClient: mockSdkClient,
    });

    const appkit = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
        files({ defaultVolume: "/Volumes/catalog/schema/vol" }),
      ],
    });

    // Routes are now auto-registered by the files plugin via injectRoutes
    await appkit.server.start();
    server = appkit.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  afterAll(async () => {
    serviceContextMock?.restore();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  beforeEach(() => {
    mockFilesApi.listDirectoryContents.mockReset();
    mockFilesApi.download.mockReset();
    mockFilesApi.getMetadata.mockReset();
    mockFilesApi.upload.mockReset();
    mockFilesApi.createDirectory.mockReset();
    mockFilesApi.delete.mockReset();
  });

  describe("List Directory", () => {
    test("GET /api/files/list returns directory entries", async () => {
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

      const response = await fetch(`${baseUrl}/api/files/list`, {
        headers: authHeaders,
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(entries);
    });

    test("GET /api/files/list?path=/abs/path uses provided path", async () => {
      mockFilesApi.listDirectoryContents.mockReturnValue(
        (async function* () {})(),
      );

      const response = await fetch(
        `${baseUrl}/api/files/list?path=/Volumes/other/path`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      expect(mockFilesApi.listDirectoryContents).toHaveBeenCalledWith({
        directory_path: "/Volumes/other/path",
      });
    });
  });

  describe("Read File", () => {
    test("GET /api/files/read?path=/file.txt returns text content", async () => {
      mockFilesApi.download.mockResolvedValue({
        contents: streamFromString("file content here"),
      });

      const response = await fetch(
        `${baseUrl}/api/files/read?path=/Volumes/catalog/schema/vol/file.txt`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("file content here");
    });

    test("GET /api/files/read without path returns 400", async () => {
      const response = await fetch(`${baseUrl}/api/files/read`, {
        headers: authHeaders,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toEqual({ error: "path is required", plugin: "files" });
    });
  });

  describe("Exists", () => {
    test("GET /api/files/exists returns { exists: true }", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 100,
        "content-type": "text/plain",
        "last-modified": "2025-01-01",
      });

      const response = await fetch(
        `${baseUrl}/api/files/exists?path=/Volumes/catalog/schema/vol/file.txt`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ exists: true });
    });

    test("GET /api/files/exists returns { exists: false } on 404", async () => {
      mockFilesApi.getMetadata.mockRejectedValue(
        new MockApiError("Not found", 404),
      );

      const response = await fetch(
        `${baseUrl}/api/files/exists?path=/Volumes/missing.txt`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ exists: false });
    });
  });

  describe("Metadata", () => {
    test("GET /api/files/metadata returns correct metadata", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 256,
        "content-type": "application/json",
        "last-modified": "2025-06-15T10:00:00Z",
      });

      const response = await fetch(
        `${baseUrl}/api/files/metadata?path=/Volumes/catalog/schema/vol/file.json`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        contentLength: 256,
        contentType: "application/json",
        lastModified: "2025-06-15T10:00:00Z",
      });
    });
  });

  describe("Preview", () => {
    test("GET /api/files/preview returns text preview", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 20,
        "content-type": "text/plain",
        "last-modified": "2025-01-01",
      });
      mockFilesApi.download.mockResolvedValue({
        contents: streamFromString("Hello preview!"),
      });

      const response = await fetch(
        `${baseUrl}/api/files/preview?path=/Volumes/catalog/schema/vol/file.txt`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        isText: boolean;
        isImage: boolean;
        textPreview: string | null;
      };
      expect(data.isText).toBe(true);
      expect(data.isImage).toBe(false);
      expect(data.textPreview).toBe("Hello preview!");
    });

    test("GET /api/files/preview returns image metadata", async () => {
      mockFilesApi.getMetadata.mockResolvedValue({
        "content-length": 5000,
        "content-type": "image/png",
        "last-modified": "2025-01-01",
      });

      const response = await fetch(
        `${baseUrl}/api/files/preview?path=/Volumes/catalog/schema/vol/image.png`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        isText: boolean;
        isImage: boolean;
        textPreview: string | null;
      };
      expect(data.isImage).toBe(true);
      expect(data.isText).toBe(false);
      expect(data.textPreview).toBeNull();
    });
  });

  describe("Error Handling", () => {
    test("SDK exceptions return 500 with error message", async () => {
      mockFilesApi.getMetadata.mockRejectedValue(
        new Error("SDK connection failed"),
      );

      const response = await fetch(
        `${baseUrl}/api/files/metadata?path=/Volumes/catalog/schema/vol/file.txt`,
        { headers: authHeaders },
      );

      expect(response.status).toBe(500);
      const data = (await response.json()) as { error: string; plugin: string };
      expect(data.error).toBe("SDK connection failed");
      expect(data.plugin).toBe("files");
    });

    test("list errors return 500", async () => {
      mockFilesApi.listDirectoryContents.mockRejectedValue(
        new Error("Permission denied"),
      );

      const response = await fetch(`${baseUrl}/api/files/list`, {
        headers: authHeaders,
      });

      expect(response.status).toBe(500);
      const data = (await response.json()) as { error: string; plugin: string };
      expect(data.error).toBe("Permission denied");
      expect(data.plugin).toBe("files");
    });
  });
});
