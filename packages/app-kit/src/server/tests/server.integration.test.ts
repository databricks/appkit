import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Server } from "node:http";

// Set required env vars BEFORE imports that use them
process.env.DATABRICKS_APP_PORT = "8000";
process.env.FLASK_RUN_HOST = "0.0.0.0";

// Mock databricks middleware to avoid auth requirements
vi.mock("../../utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../utils")>();
  return {
    ...original,
    databricksClientMiddleware: vi
      .fn()
      .mockResolvedValue((_req: any, _res: any, next: any) => next()),
  };
});

import { createApp } from "../../core";
import { server as serverPlugin } from "../index";
import { Plugin, toPlugin } from "../../plugin";

// Integration tests - actually start server and make HTTP requests
describe("ServerPlugin Integration", () => {
  let server: Server;
  let baseUrl: string;
  const TEST_PORT = 9876; // Use non-standard port to avoid conflicts

  beforeAll(async () => {
    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
      ],
    });

    // Start server manually
    const expressApp = await app.server.start();
    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    // Wait a bit for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  describe("health endpoint", () => {
    test("GET /health returns 200 with status ok", async () => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ status: "ok" });
    });
  });

  describe("API routing", () => {
    test("unknown API route returns 404", async () => {
      const response = await fetch(`${baseUrl}/api/nonexistent`);

      expect(response.status).toBe(404);
    });
  });

  describe("server lifecycle", () => {
    test("server is listening on correct port", () => {
      const address = server.address();

      expect(address).not.toBeNull();
      if (typeof address === "object" && address !== null) {
        expect(address.port).toBe(TEST_PORT);
      }
    });
  });
});

describe("ServerPlugin with custom plugin", () => {
  let server: Server;
  let baseUrl: string;
  const TEST_PORT = 9877;

  beforeAll(async () => {
    // Create a simple test plugin
    class TestPlugin extends Plugin {
      name = "test-plugin" as const;
      envVars: string[] = [];

      injectRoutes(router: any) {
        router.get("/echo", (_req: any, res: any) => {
          res.json({ message: "hello from test plugin" });
        });

        router.post("/echo", (req: any, res: any) => {
          res.json({ received: req.body });
        });
      }
    }

    const testPlugin = toPlugin<typeof TestPlugin, any, "test-plugin">(
      TestPlugin,
      "test-plugin",
    );

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
        testPlugin({}),
      ],
    });

    await app.server.start();
    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  test("GET /api/test-plugin/echo returns plugin response", async () => {
    const response = await fetch(`${baseUrl}/api/test-plugin/echo`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ message: "hello from test plugin" });
  });

  test("POST /api/test-plugin/echo returns posted body", async () => {
    const response = await fetch(`${baseUrl}/api/test-plugin/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ received: { foo: "bar" } });
  });
});

describe("ServerPlugin with extend()", () => {
  let server: Server;
  let baseUrl: string;
  const TEST_PORT = 9878;

  beforeAll(async () => {
    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
          autoStart: false,
        }),
      ],
    });

    // Add custom route via extend()
    app.server.extend((expressApp) => {
      expressApp.get("/custom", (_req, res) => {
        res.json({ custom: true });
      });
    });

    await app.server.start();
    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  test("custom route via extend() works", async () => {
    const response = await fetch(`${baseUrl}/custom`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ custom: true });
  });
});
