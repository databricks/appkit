import type { Server } from "node:http";
import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Set required env vars BEFORE imports that use them
process.env.DATABRICKS_APP_PORT = "8000";
process.env.FLASK_RUN_HOST = "0.0.0.0";

import type { PluginManifest } from "shared";
import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { Plugin, toPlugin } from "../../../plugin";
import { server as serverPlugin } from "../index";

// Integration tests - actually start server and make HTTP requests
describe("ServerPlugin Integration", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9876; // Use non-standard port to avoid conflicts

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
        }),
      ],
    });

    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    // Wait a bit for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9877;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    // Create a simple test plugin
    class TestPlugin extends Plugin {
      static manifest = {
        name: "test-plugin",
        displayName: "Test Plugin",
        description: "Test plugin for integration tests",
        resources: { required: [], optional: [] },
      } satisfies PluginManifest<"test-plugin">;

      injectRoutes(router: any) {
        router.get("/echo", (_req: any, res: any) => {
          res.json({ message: "hello from test plugin" });
        });

        router.post("/echo", (req: any, res: any) => {
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

describe("ServerPlugin with extend() via onPluginsReady", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9878;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
        }),
      ],
      onPluginsReady(appkit) {
        appkit.server.extend((expressApp) => {
          expressApp.get("/custom", (_req, res) => {
            res.json({ custom: true });
          });
        });
      },
    });

    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    await new Promise((resolve) => setTimeout(resolve, 100));
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

  test("custom route via extend() in onPluginsReady callback works", async () => {
    const response = await fetch(`${baseUrl}/custom`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ custom: true });
  });
});

describe("createApp with async onPluginsReady callback", () => {
  let server: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  const TEST_PORT = 9885;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    const app = await createApp({
      plugins: [
        serverPlugin({
          port: TEST_PORT,
          host: "127.0.0.1",
        }),
      ],
      async onPluginsReady(appkit) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        appkit.server.extend((expressApp) => {
          expressApp.get("/async-custom", (_req, res) => {
            res.json({ asyncSetup: true });
          });
        });
      },
    });

    server = app.server.getServer();
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;

    await new Promise((resolve) => setTimeout(resolve, 100));
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

  test("async onPluginsReady callback runs before server starts", async () => {
    const response = await fetch(`${baseUrl}/async-custom`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ asyncSetup: true });
  });
});

describe("createApp without server plugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  let onPluginsReadyWasCalled = false;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    await createApp({
      plugins: [],
      onPluginsReady() {
        onPluginsReadyWasCalled = true;
      },
    });
  });

  afterAll(async () => {
    serviceContextMock?.restore();
  });

  test("onPluginsReady callback is still called without server plugin", () => {
    expect(onPluginsReadyWasCalled).toBe(true);
  });
});
