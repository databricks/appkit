import type { Server } from "node:http";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import {
  afterAll,
  afterEach,
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
import { streamFromString } from "./utils";

const { mockFilesApi, mockSdkClient } = vi.hoisted(() => {
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

  return { mockFilesApi, mockSdkClient };
});

vi.mock("@databricks/sdk-experimental", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@databricks/sdk-experimental")>();
  return { ...actual };
});

const MOCK_AUTH_HEADERS = {
  "x-forwarded-access-token": "test-token",
  "x-forwarded-user": "test-user",
};

const VOL = "files";

/**
 * Build a multipart/form-data body manually.
 * Returns the body buffer and boundary string.
 */
function buildMultipart(files: { fieldname: string; content: Buffer }[]): {
  body: Buffer;
  boundary: string;
} {
  const boundary = "----TestBoundary" + Date.now();
  const parts: Buffer[] = [];

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.fieldname}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(file.content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

describe("Files Plugin Bulk Operations Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9881;

  // Track fetch calls for upload verification
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    setupDatabricksEnv({
      DATABRICKS_VOLUME_FILES: "/Volumes/catalog/schema/vol",
    });
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
        files(),
      ],
    });

    await appkit.server.start();
    server = appkit.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  afterAll(async () => {
    delete process.env.DATABRICKS_VOLUME_FILES;
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
    // Reset only the SDK file API mocks, not all mocks (ServiceContext mock must persist)
    mockFilesApi.listDirectoryContents.mockReset();
    mockFilesApi.download.mockReset();
    mockFilesApi.getMetadata.mockReset();
    mockFilesApi.upload.mockReset();
    mockFilesApi.createDirectory.mockReset();
    mockFilesApi.delete.mockReset();

    // Mock fetch for upload operations (connector.upload uses fetch directly)
    fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      // Intercept upload calls to Databricks REST API
      if (
        urlStr.includes("test.databricks.com/api/2.0/fs/files") &&
        init?.method === "PUT"
      ) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      // Pass through to actual fetch for local test server requests
      return originalFetch(url, init);
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Bulk Upload", () => {
    test("POST /api/files/:vol/bulk-upload uploads multiple files", async () => {
      const { body, boundary } = buildMultipart([
        { fieldname: "dir/file1.txt", content: Buffer.from("content1") },
        { fieldname: "dir/file2.txt", content: Buffer.from("content2") },
        { fieldname: "dir/file3.txt", content: Buffer.from("content3") },
      ]);

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        results: Array<{
          path: string;
          success: boolean;
          bytesWritten?: number;
        }>;
      };

      expect(data.results).toHaveLength(3);
      for (const result of data.results) {
        expect(result.success).toBe(true);
        expect(result.bytesWritten).toBeGreaterThan(0);
      }

      // Verify fetch was called for each file upload
      const uploadCalls = (fetchMock.mock.calls as unknown[][]).filter(
        (call) => {
          const url = typeof call[0] === "string" ? call[0] : String(call[0]);
          const init = call[1] as RequestInit | undefined;
          return (
            url.includes("test.databricks.com/api/2.0/fs/files") &&
            init?.method === "PUT"
          );
        },
      );
      expect(uploadCalls).toHaveLength(3);
    });

    test("rejects non-multipart content type", async () => {
      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({ files: [] }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toMatch(/multipart\/form-data/);
    });

    test("reports partial failures per file", async () => {
      // Make uploads to paths containing "bad" always fail (survives retries)
      fetchMock.mockImplementation(
        (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (
            urlStr.includes("test.databricks.com/api/2.0/fs/files") &&
            init?.method === "PUT"
          ) {
            if (urlStr.includes("bad")) {
              return Promise.resolve(
                new Response("Upload forbidden", { status: 403 }),
              );
            }
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          return originalFetch(url, init);
        },
      );

      const { body, boundary } = buildMultipart([
        { fieldname: "dir/good1.txt", content: Buffer.from("ok") },
        { fieldname: "dir/bad.txt", content: Buffer.from("fail") },
        { fieldname: "dir/good2.txt", content: Buffer.from("ok") },
      ]);

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        results: Array<{
          path: string;
          success: boolean;
          error?: string;
        }>;
      };

      const successes = data.results.filter((r) => r.success);
      const failures = data.results.filter((r) => !r.success);
      expect(successes.length).toBeGreaterThanOrEqual(1);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].error).toBeDefined();
    });
  });

  describe("Bulk Upload Stream", () => {
    test("requires X-File-Count header", async () => {
      const { body, boundary } = buildMultipart([
        { fieldname: "file1.txt", content: Buffer.from("data") },
      ]);

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload-stream`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toMatch(/X-File-Count/);
    });

    test("uploads files with X-File-Count header", async () => {
      const { body, boundary } = buildMultipart([
        { fieldname: "stream/file1.txt", content: Buffer.from("data1") },
        { fieldname: "stream/file2.txt", content: Buffer.from("data2") },
      ]);

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload-stream`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "x-file-count": "2",
          },
          body,
        },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        results: Array<{ path: string; success: boolean }>;
      };
      expect(data.results).toHaveLength(2);
      expect(data.results.every((r) => r.success)).toBe(true);
    });

    test("rejects non-numeric X-File-Count", async () => {
      const { body, boundary } = buildMultipart([]);

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-upload-stream`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "x-file-count": "abc",
          },
          body,
        },
      );

      expect(response.status).toBe(400);
    });
  });

  describe("Bulk Download", () => {
    test("POST /api/files/:vol/bulk-download returns multipart/mixed", async () => {
      mockFilesApi.download
        .mockResolvedValueOnce({ contents: streamFromString("hello1") })
        .mockResolvedValueOnce({ contents: streamFromString("hello2") });

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-download`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            paths: ["file1.txt", "file2.txt"],
          }),
        },
      );

      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type") ?? "";
      expect(contentType).toContain("multipart/mixed");

      const body = await response.text();
      // Should contain both file contents
      expect(body).toContain("hello1");
      expect(body).toContain("hello2");
      // Should contain a JSON summary part
      expect(body).toContain('"success"');
    });

    test("rejects empty paths array", async () => {
      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-download`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({ paths: [] }),
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toMatch(/non-empty/);
    });

    test("rejects missing paths", async () => {
      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-download`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
    });

    test("includes failed files in summary", async () => {
      mockFilesApi.download
        .mockResolvedValueOnce({ contents: streamFromString("ok") })
        .mockRejectedValueOnce(new Error("Not found"));

      const response = await originalFetch(
        `${baseUrl}/api/files/${VOL}/bulk-download`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            paths: ["good.txt", "bad.txt"],
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = await response.text();

      // Should contain the successful file content
      expect(body).toContain("ok");

      // Parse summary from the last multipart part
      const summaryMatch = body.match(
        /Content-Disposition: inline; name="summary"\r\n\r\n([\s\S]*?)\r\n--/,
      );
      expect(summaryMatch).not.toBeNull();
      const summary = JSON.parse(summaryMatch![1]) as Array<{
        path: string;
        success: boolean;
        error?: string;
      }>;

      const goodResult = summary.find((r) => r.path === "good.txt");
      const badResult = summary.find((r) => r.path === "bad.txt");
      expect(goodResult?.success).toBe(true);
      expect(badResult?.success).toBe(false);
      expect(badResult?.error).toBeDefined();
    });
  });

  describe("Unknown Volume for Bulk", () => {
    test("bulk-upload to unknown volume returns 404", async () => {
      const { body, boundary } = buildMultipart([
        { fieldname: "f.txt", content: Buffer.from("x") },
      ]);

      const response = await originalFetch(
        `${baseUrl}/api/files/nonexistent/bulk-upload`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        },
      );
      expect(response.status).toBe(404);
    });

    test("bulk-download from unknown volume returns 404", async () => {
      const response = await originalFetch(
        `${baseUrl}/api/files/nonexistent/bulk-download`,
        {
          method: "POST",
          headers: {
            ...MOCK_AUTH_HEADERS,
            "content-type": "application/json",
          },
          body: JSON.stringify({ paths: ["f.txt"] }),
        },
      );
      expect(response.status).toBe(404);
    });
  });
});
