import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analytics } from "../../analytics";
import { Plugin, toPlugin } from "../../plugin";
import { createTestServer, type TestServerResult } from "./test-server";

describe("Server Plugin Integration", () => {
  let testServer: TestServerResult;

  beforeAll(async () => {
    testServer = await createTestServer({ plugins: [analytics({})] });
  });

  afterAll(async () => {
    await testServer.cleanup();
  });

  describe("Health Endpoint", () => {
    test("GET /health returns 200 with status ok", async () => {
      const response = await fetch(`${testServer.baseUrl}/health`);

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({ status: "ok" });
    });

    test("GET /health returns correct Content-Type", async () => {
      const response = await fetch(`${testServer.baseUrl}/health`);

      expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
    });
  });

  describe("Plugin Routing", () => {
    test("analytics plugin is mounted at /api/analytics", async () => {
      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: "SELECT 1",
        isAsUser: false,
      });

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parameters: {} }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });
  });

  describe("404 Handling", () => {
    test("unknown API route returns 404", async () => {
      const response = await fetch(`${testServer.baseUrl}/api/nonexistent`);

      expect(response.status).toBe(404);
    });

    test("unknown root route returns 404", async () => {
      const response = await fetch(`${testServer.baseUrl}/unknown-path`);

      expect(response.status).toBe(404);
    });

    test("unknown analytics sub-route returns 404", async () => {
      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/unknown-endpoint`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("Request Methods", () => {
    test("analytics query endpoint only accepts POST", async () => {
      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/test`,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(404);
    });

    test("health endpoint only accepts GET", async () => {
      const response = await fetch(`${testServer.baseUrl}/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("JSON Body Parsing", () => {
    test("server parses JSON request bodies", async () => {
      testServer.getAppQueryMock.mockResolvedValueOnce({
        query: "SELECT :value",
        isAsUser: false,
      });

      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/json_test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parameters: { value: { __sql_type: "STRING", value: "test" } },
          }),
        },
      );

      expect(response.status).toBe(200);
    });

    test("server handles invalid JSON gracefully", async () => {
      const response = await fetch(
        `${testServer.baseUrl}/api/analytics/query/invalid_json`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ invalid json }",
        },
      );

      expect(response.status).toBe(400);
    });
  });
});

describe("Server Lifecycle", () => {
  test("server cleanup properly closes connections", async () => {
    const server = await createTestServer({ plugins: [] });
    const baseUrl = server.baseUrl;
    await server.cleanup();

    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
  });

  test("server is listening on correct port", async () => {
    const testServer = await createTestServer({ plugins: [] });

    try {
      const address = testServer.server.address();

      expect(address).not.toBeNull();
      if (typeof address === "object" && address !== null) {
        expect(address.port).toBe(testServer.port);
      }
    } finally {
      await testServer.cleanup();
    }
  });
});

describe("Custom Plugin Routing", () => {
  let testServer: TestServerResult;

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

  beforeAll(async () => {
    testServer = await createTestServer({ plugins: [testPlugin({})] });
  });

  afterAll(async () => {
    await testServer.cleanup();
  });

  test("GET /api/test-plugin/echo returns plugin response", async () => {
    const response = await fetch(`${testServer.baseUrl}/api/test-plugin/echo`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ message: "hello from test plugin" });
  });

  test("POST /api/test-plugin/echo returns posted body", async () => {
    const response = await fetch(`${testServer.baseUrl}/api/test-plugin/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ received: { foo: "bar" } });
  });
});

describe("Server extend() API", () => {
  let testServer: TestServerResult;

  beforeAll(async () => {
    testServer = await createTestServer({
      plugins: [],
      extend: (expressApp) => {
        expressApp.get("/custom", (_req, res) => {
          res.json({ custom: true });
        });
      },
    });
  });

  afterAll(async () => {
    await testServer.cleanup();
  });

  test("custom route via extend() works", async () => {
    const response = await fetch(`${testServer.baseUrl}/custom`);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ custom: true });
  });
});
