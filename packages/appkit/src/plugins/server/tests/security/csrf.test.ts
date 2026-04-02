import express from "express";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCsrfMiddleware } from "../../security/csrf";

function createTestApp(config?: Parameters<typeof createCsrfMiddleware>[0]) {
  const app = express();
  app.use(createCsrfMiddleware(config));
  app.post("/test", (_req, res) => res.json({ ok: true }));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  app.put("/test", (_req, res) => res.json({ ok: true }));
  app.delete("/test", (_req, res) => res.json({ ok: true }));
  app.patch("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

async function request(
  app: express.Application,
  method: string,
  path: string,
  headers?: Record<string, string>,
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers,
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("CSRF Middleware", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABRICKS_APP_URL", "https://my-app.databricksapps.com");
    delete process.env.APPKIT_CSRF_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("method filtering", () => {
    test("GET requests bypass CSRF", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(200);
    });

    test("POST requests are checked", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
    });

    test("PUT requests are checked", async () => {
      const app = createTestApp();
      const res = await request(app, "PUT", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
    });

    test("DELETE requests are checked", async () => {
      const app = createTestApp();
      const res = await request(app, "DELETE", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
    });

    test("PATCH requests are checked", async () => {
      const app = createTestApp();
      const res = await request(app, "PATCH", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("origin validation", () => {
    test("allows POST without Origin header (same-origin)", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test");
      expect(res.status).toBe(200);
    });

    test("rejects POST with Origin: null", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", { origin: "null" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("CSRF validation failed");
    });

    test("allows POST with matching DATABRICKS_APP_URL origin", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://my-app.databricksapps.com",
      });
      expect(res.status).toBe(200);
    });

    test("rejects POST with non-matching origin", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
    });

    test("case-insensitive origin comparison", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://MY-APP.DATABRICKSAPPS.COM",
      });
      expect(res.status).toBe(200);
    });

    test("rejects non-HTTPS origins in production", async () => {
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "http://my-app.databricksapps.com",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("config allowedOrigins", () => {
    test("allows additional configured origins", async () => {
      const app = createTestApp({
        allowedOrigins: ["https://partner.example.com"],
      });
      const res = await request(app, "POST", "/test", {
        origin: "https://partner.example.com",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("APPKIT_CSRF_ALLOWED_ORIGINS env var", () => {
    test("merges origins from env var", async () => {
      vi.stubEnv(
        "APPKIT_CSRF_ALLOWED_ORIGINS",
        "https://extra1.com, https://extra2.com",
      );
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://extra1.com",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("Host header fallback", () => {
    test("falls back to Host header when no trusted origins configured", async () => {
      delete process.env.DATABRICKS_APP_URL;
      const app = createTestApp();

      // fetch sets Host header automatically
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/test`, {
          method: "POST",
          headers: { origin: `http://127.0.0.1:${addr.port}` },
        });
        // In production, non-HTTPS is rejected before fallback
        expect(res.status).toBe(403);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("dev mode", () => {
    test("allows localhost origins in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      delete process.env.DATABRICKS_APP_URL;
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "http://localhost:5173",
      });
      expect(res.status).toBe(200);
    });

    test("allows 127.0.0.1 origins in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      delete process.env.DATABRICKS_APP_URL;
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "http://127.0.0.1:8000",
      });
      expect(res.status).toBe(200);
    });

    test("still rejects non-localhost origins in dev mode", async () => {
      vi.stubEnv("NODE_ENV", "development");
      delete process.env.DATABRICKS_APP_URL;
      const app = createTestApp();
      const res = await request(app, "POST", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(403);
      // Dev mode includes detail
      expect(res.body.detail).toBeDefined();
    });
  });

  describe("disabled", () => {
    test("csrf: false disables all CSRF checks", async () => {
      const app = createTestApp(false);
      const res = await request(app, "POST", "/test", {
        origin: "https://evil.com",
      });
      expect(res.status).toBe(200);
    });
  });
});
