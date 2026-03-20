import { EventEmitter } from "node:events";
import http from "node:http";
import { createMockTelemetry } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockProxyRes = vi.hoisted(() => {
  function create(statusCode = 200, headers: Record<string, string> = {}) {
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      pipe: ReturnType<typeof vi.fn>;
    };
    res.statusCode = statusCode;
    res.headers = { "content-type": "application/json", ...headers };
    res.pipe = vi.fn((target) => {
      // Simulate pipe completion
      process.nextTick(() => res.emit("end"));
      return target;
    });
    return res;
  }
  return { create };
});

const mockHttpRequest = vi.hoisted(() => {
  const fn = vi.fn();
  return fn;
});

vi.mock("node:http", () => ({
  default: {
    request: mockHttpRequest,
  },
}));

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SidecarProxy } from "../proxy";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createExtendedMockTelemetry() {
  const base = createMockTelemetry();
  const meter = base.getMeter();
  (meter as any).createUpDownCounter = vi.fn().mockReturnValue({ add: vi.fn() });
  return base;
}

function createMockReq(overrides: Record<string, any> = {}) {
  const req = new EventEmitter() as any;
  req.method = overrides.method ?? "GET";
  req.path = overrides.path ?? "/api/test";
  req.url = overrides.url ?? req.path;
  req.headers = overrides.headers ?? {};
  req.pipe = vi.fn().mockReturnThis();
  return req;
}

function createMockRes() {
  const res: any = {
    headersSent: false,
  };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.pipe = vi.fn().mockReturnValue(res);
  return res;
}

function setupHttpMock(
  statusCode = 200,
  responseHeaders: Record<string, string> = {},
) {
  const proxyRes = mockProxyRes.create(statusCode, responseHeaders);
  const proxyReq = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
  };
  proxyReq.destroy = vi.fn();

  mockHttpRequest.mockImplementation((_opts: any, callback: (res: any) => void) => {
    process.nextTick(() => callback(proxyRes));
    return proxyReq;
  });

  return { proxyReq, proxyRes };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SidecarProxy", () => {
  let telemetry: ReturnType<typeof createMockTelemetry>;

  beforeEach(() => {
    vi.clearAllMocks();
    telemetry = createExtendedMockTelemetry();
  });

  // ──────────────── B. Security — Path Validation ────────────────

  describe("B. Path Security", () => {
    test("B2: path traversal with ../ is neutralized by normalize", async () => {
      // With basePath "/", normalize removes ".." so /../../etc/passwd → /etc/passwd
      // This is safe because the child only sees /etc/passwd, not a traversal
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        path: "/../../etc/passwd",
        url: "/../../etc/passwd",
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      // The path is normalized — no ".." sent to child
      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.path).toBe("/etc/passwd");
      expect(opts.path).not.toContain("..");
    });

    test("B3: null bytes in path are rejected", () => {
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({ path: "/test\0evil" });
      const res = createMockRes();

      middleware(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid request path" });
    });

    test("B2: path with .. segments normalizes safely with non-root basePath", async () => {
      // posixPath.normalize removes .. before it reaches the child
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, { basePath: "/api/v1" });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        path: "/../secret",
        url: "/../secret",
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      // normalize removes ".." → child sees /api/v1/secret (stays within basePath)
      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.path).not.toContain("..");
      expect(opts.path).toMatch(/^\/api\/v1/);
    });
  });

  // ──────────────── C. HTTP Proxy Behavior ────────────────

  describe("C. HTTP Proxy Behavior", () => {
    test("returns 503 when sidecar is not healthy", () => {
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "starting");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Sidecar process is not ready" }),
      );
    });

    test("C1: GET request is proxied correctly", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        method: "GET",
        path: "/health",
        url: "/health?foo=bar",
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.method).toBe("GET");
      expect(opts.path).toBe("/health?foo=bar");
      expect(opts.hostname).toBe("localhost");
      expect(opts.port).toBe(3000);
    });

    test("C2: POST with body is piped to child", async () => {
      setupHttpMock(201);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({ method: "POST", path: "/data" });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(req.pipe).toHaveBeenCalled();
      });
    });

    test("C3: PUT and DELETE are forwarded", async () => {
      for (const method of ["PUT", "DELETE"]) {
        vi.clearAllMocks();
        setupHttpMock(200);
        const proxy = new SidecarProxy(3000, telemetry);
        const middleware = proxy.middleware(() => "healthy");
        const req = createMockReq({ method, path: "/resource" });
        const res = createMockRes();

        middleware(req, res);
        await vi.waitFor(() => {
          expect(mockHttpRequest).toHaveBeenCalled();
        });

        const opts = mockHttpRequest.mock.calls[0][0];
        expect(opts.method).toBe(method);
      }
    });

    test("C6: forwardHeaders 'all' forwards non-hop-by-hop headers", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, { forwardHeaders: "all" });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        headers: {
          "content-type": "application/json",
          "x-custom": "value",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
        },
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.headers["content-type"]).toBe("application/json");
      expect(opts.headers["x-custom"]).toBe("value");
      // Hop-by-hop headers should be stripped
      expect(opts.headers.connection).toBeUndefined();
      expect(opts.headers["keep-alive"]).toBeUndefined();
    });

    test("C7: forwardHeaders with specific list only forwards listed headers", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, {
        forwardHeaders: ["x-custom"],
      });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        headers: {
          "content-type": "application/json",
          "x-custom": "value",
        },
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.headers["x-custom"]).toBe("value");
      expect(opts.headers["content-type"]).toBeUndefined();
    });

    test("C8: hop-by-hop headers are stripped from response", async () => {
      const proxyRes = mockProxyRes.create(200, {
        "content-type": "application/json",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
      });
      const proxyReq = new EventEmitter() as any;
      proxyReq.destroy = vi.fn();

      mockHttpRequest.mockImplementation((_opts: any, callback: (res: any) => void) => {
        process.nextTick(() => callback(proxyRes));
        return proxyReq;
      });

      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(200);
      });

      // Non-hop-by-hop headers should be set on response
      expect(res.setHeader).toHaveBeenCalledWith("content-type", "application/json");
      // Hop-by-hop headers should NOT be set
      const setHeaderCalls = res.setHeader.mock.calls.map((c: any[]) => c[0]);
      expect(setHeaderCalls).not.toContain("connection");
      expect(setHeaderCalls).not.toContain("transfer-encoding");
    });

    test("C9: injectHeaders are added to proxied request", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, {
        injectHeaders: { "x-injected": "injected-value" },
      });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.headers["x-injected"]).toBe("injected-value");
    });

    test("C10: auth headers always forwarded even with specific forwardHeaders", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, {
        forwardHeaders: ["x-custom"],
      });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        headers: {
          "x-forwarded-user": "user123",
          "x-forwarded-access-token": "token456",
          "x-custom": "val",
        },
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.headers["x-forwarded-user"]).toBe("user123");
      expect(opts.headers["x-forwarded-access-token"]).toBe("token456");
    });

    test("C11: host header is rewritten to localhost:port", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        headers: { host: "example.com" },
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.headers.host).toBe("localhost:3000");
    });

    test("C12: basePath is applied to target path", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, { basePath: "/v1" });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({ path: "/users" });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.path).toBe("/v1/users");
    });

    test("C13: proxy timeout triggers 504", async () => {
      const proxyReq = new EventEmitter() as any;
      proxyReq.destroy = vi.fn();

      mockHttpRequest.mockImplementation(() => proxyReq);

      const proxy = new SidecarProxy(3000, telemetry, { timeout: 1000 });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);

      // Simulate timeout event
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      proxyReq.emit("timeout");

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(504);
      });
      expect(res.json).toHaveBeenCalledWith({ error: "Sidecar request timed out" });
      expect(proxyReq.destroy).toHaveBeenCalled();
    });

    test("C14: ECONNREFUSED returns 502", async () => {
      const proxyReq = new EventEmitter() as any;
      proxyReq.destroy = vi.fn();

      mockHttpRequest.mockImplementation(() => proxyReq);

      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const connRefused = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      proxyReq.emit("error", connRefused);

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(502);
      });
      expect(res.json).toHaveBeenCalledWith({
        error: "Sidecar process is unavailable",
      });
    });

    test("C14: generic proxy error returns 502", async () => {
      const proxyReq = new EventEmitter() as any;
      proxyReq.destroy = vi.fn();

      mockHttpRequest.mockImplementation(() => proxyReq);

      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      proxyReq.emit("error", new Error("Something went wrong"));

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(502);
      });
      expect(res.json).toHaveBeenCalledWith({
        error: "Failed to proxy request to sidecar",
      });
    });

    test("query string is forwarded", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({
        path: "/search",
        url: "/search?q=hello&page=2",
      });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.path).toBe("/search?q=hello&page=2");
    });

    test("no query string when url has none", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({ path: "/data", url: "/data" });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.path).toBe("/data");
    });

    test("status code is forwarded from proxy response", async () => {
      setupHttpMock(404);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(404);
      });
    });

    test("proxy response body is piped to client", async () => {
      const proxyRes = mockProxyRes.create(200);
      const proxyReq = new EventEmitter() as any;
      proxyReq.destroy = vi.fn();

      mockHttpRequest.mockImplementation((_opts: any, callback: any) => {
        process.nextTick(() => callback(proxyRes));
        return proxyReq;
      });

      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(proxyRes.pipe).toHaveBeenCalledWith(res);
      });
    });

    test("timeout config is passed to http.request", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry, { timeout: 5000 });
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(mockHttpRequest).toHaveBeenCalled();
      });

      const opts = mockHttpRequest.mock.calls[0][0];
      expect(opts.timeout).toBe(5000);
    });
  });

  // ──────────────── H. Telemetry ────────────────

  describe("H. Telemetry", () => {
    test("H1: proxy request creates span", async () => {
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq({ path: "/test", method: "GET" });
      const res = createMockRes();

      middleware(req, res);
      await vi.waitFor(() => {
        expect(telemetry.startActiveSpan).toHaveBeenCalledWith(
          "sidecar.proxy.request",
          expect.objectContaining({
            attributes: expect.objectContaining({
              "sidecar.proxy.path": "/test",
              "sidecar.proxy.method": "GET",
            }),
          }),
          expect.any(Function),
        );
      });
    });

    test("H8: telemetry is no-op when not configured (uses mock)", async () => {
      // The mock telemetry is essentially no-op — verify it doesn't throw
      setupHttpMock(200);
      const proxy = new SidecarProxy(3000, telemetry);
      const middleware = proxy.middleware(() => "healthy");
      const req = createMockReq();
      const res = createMockRes();

      expect(() => middleware(req, res)).not.toThrow();
    });
  });
});
