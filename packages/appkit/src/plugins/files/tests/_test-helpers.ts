import { Readable } from "node:stream";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import type { FilesPlugin } from "../plugin";
import { policy } from "../policy";

export const VOLUMES_CONFIG = {
  volumes: {
    uploads: { maxUploadSize: 100_000_000, policy: policy.allowAll() },
    exports: { policy: policy.allowAll() },
  },
};

/**
 * Get a registered route handler from a FilesPlugin by HTTP method and path
 * suffix. Useful when a test wants to invoke a single route in isolation.
 */
export function getRouteHandler(
  plugin: FilesPlugin,
  method: "get" | "post" | "delete",
  pathSuffix: string,
) {
  const mockRouter = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  } as any;

  plugin.injectRoutes(mockRouter);

  const call = mockRouter[method].mock.calls.find(
    (c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).endsWith(pathSuffix),
  );
  if (!call) throw new Error(`No route found for ${method} ...${pathSuffix}`);
  return call[call.length - 1] as (req: any, res: any) => Promise<void>;
}

export function mockRes() {
  const res: any = {
    headersSent: false,
  };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.write = vi.fn().mockReturnValue(true);
  res.destroy = vi.fn();
  res.end = vi.fn();
  res.on = vi.fn().mockReturnValue(res);
  res.once = vi.fn().mockReturnValue(res);
  res.emit = vi.fn().mockReturnValue(true);
  res.removeListener = vi.fn().mockReturnValue(res);
  res.pipe = vi.fn().mockReturnValue(res);
  return res;
}

export function mockReq(
  volumeKey: string,
  overrides: Record<string, any> = {},
): any {
  // Lowercase override header keys so `req.header(name)` (case-insensitive
  // via toLowerCase) matches them regardless of how callers cased the keys.
  const lowercased: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides.headers ?? {})) {
    lowercased[k.toLowerCase()] = v as string;
  }
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "test-token",
    "x-forwarded-user": "test-user",
    ...lowercased,
  };

  const req: any = {
    params: { volumeKey },
    query: {},
    ...overrides,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  };

  return req;
}

/**
 * Mock Express request that behaves as a Node Readable stream — needed by the
 * upload handler which calls Readable.toWeb(req).
 */
export function mockUploadReq(
  volumeKey: string,
  bodyChunks: Buffer[],
  overrides: Record<string, any> = {},
): any {
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "test-token",
    "x-forwarded-user": "test-user",
    ...(overrides.headers ?? {}),
  };

  let chunkIndex = 0;
  const stream = new Readable({
    read() {
      if (chunkIndex < bodyChunks.length) {
        this.push(bodyChunks[chunkIndex++]);
      } else {
        this.push(null);
      }
    },
  });

  (stream as any).params = { volumeKey };
  (stream as any).query = overrides.query ?? {};
  (stream as any).headers = headers;
  (stream as any).header = (name: string) => headers[name.toLowerCase()];
  (stream as any).body = overrides.body;

  return stream;
}

export function makeStreamResponse(content: string) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
  return { contents: stream };
}

export async function setupTestEnv() {
  vi.clearAllMocks();
  setupDatabricksEnv();
  ServiceContext.reset();
  process.env.DATABRICKS_VOLUME_UPLOADS = "/Volumes/catalog/schema/uploads";
  process.env.DATABRICKS_VOLUME_EXPORTS = "/Volumes/catalog/schema/exports";
  return mockServiceContext();
}

export function teardownTestEnv(
  serviceContextMock:
    | Awaited<ReturnType<typeof mockServiceContext>>
    | undefined,
) {
  serviceContextMock?.restore();
  delete process.env.DATABRICKS_VOLUME_UPLOADS;
  delete process.env.DATABRICKS_VOLUME_EXPORTS;
}
