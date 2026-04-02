import type { Server } from "node:http";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import type { PluginManifest } from "shared";
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
import { ServiceContext } from "../../../../context/service-context";
import { createApp } from "../../../../core";
import { Plugin, toPlugin } from "../../../../plugin";
import { server as serverPlugin } from "../../index";

describe("Security Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9890;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABRICKS_APP_URL", "https://my-app.databricksapps.com");
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    class TestPlugin extends Plugin {
      static manifest = {
        name: "test-sec",
        displayName: "Test Security Plugin",
        description: "Test plugin for security integration tests",
        resources: { required: [], optional: [] },
      } satisfies PluginManifest<"test-sec">;

      injectRoutes(router: any) {
        router.get("/data", (_req: any, res: any) => {
          res.json({ data: "hello" });
        });
        router.post("/data", (req: any, res: any) => {
          res.json({ received: req.body });
        });
      }
    }

    const testPlugin = toPlugin(TestPlugin);

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
        }),
        testPlugin({}),
      ],
    });

    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
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

  describe("security headers (Helmet)", () => {
    test("sets Content-Security-Policy on responses", async () => {
      const res = await fetch(`${baseUrl}/health`);
      const csp = res.headers.get("content-security-policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    test("sets X-Content-Type-Options: nosniff", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("sets Cross-Origin-Opener-Policy", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    });

    test("sets X-Frame-Options", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.headers.get("x-frame-options")).toBeDefined();
    });
  });

  describe("CSRF protection", () => {
    test("GET requests pass through CSRF", async () => {
      const res = await fetch(`${baseUrl}/api/test-sec/data`, {
        headers: { origin: "https://evil.com" },
      });
      expect(res.status).toBe(200);
    });

    test("POST without Origin passes (same-origin)", async () => {
      const res = await fetch(`${baseUrl}/api/test-sec/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(200);
    });

    test("POST with matching origin passes", async () => {
      const res = await fetch(`${baseUrl}/api/test-sec/data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://my-app.databricksapps.com",
        },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(200);
    });

    test("POST with evil origin is rejected 403", async () => {
      const res = await fetch(`${baseUrl}/api/test-sec/data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.com",
        },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("CSRF validation failed");
    });

    test("POST with Origin: null is rejected 403", async () => {
      const res = await fetch(`${baseUrl}/api/test-sec/data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "null",
        },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("CORS (disabled by default)", () => {
    test("no Access-Control headers when CORS is not configured", async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://other.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
