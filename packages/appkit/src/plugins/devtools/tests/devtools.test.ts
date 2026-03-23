import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@tools/test-helpers";
import type { PluginManifest } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plugin } from "../../../plugin";
import { DevtoolsPlugin, devtools } from "../devtools";

const { mockCacheInstance } = vi.hoisted(() => ({
  mockCacheInstance: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(),
  },
}));

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

class FakeAnalyticsPlugin extends Plugin {
  static manifest = {
    name: "analytics",
    displayName: "Analytics Plugin",
    description: "SQL query execution against Databricks SQL Warehouses",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"analytics">;

  getEndpoints() {
    return {
      query: "/api/analytics/query/demo",
    };
  }
}

function createMiddlewareHarness() {
  let middleware: any;
  const app = {
    use: vi.fn((fn: any) => {
      middleware = fn;
    }),
  } as any;

  return {
    app,
    getMiddleware() {
      return middleware;
    },
  };
}

function createEventResponse(statusCode = 200) {
  const listeners = new Map<string, () => void>();
  return {
    statusCode,
    once(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
    finish() {
      listeners.get("finish")?.();
    },
  };
}

describe("DevtoolsPlugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("factory exposes the devtools plugin name", () => {
    expect(devtools({}).name).toBe("devtools");
  });

  test("registers bootstrap contribution and runtime config", () => {
    const plugin = new DevtoolsPlugin({});
    const { router } = createMockRouter();

    plugin.injectRoutes(router);

    expect(plugin.getBootstrapContributions()).toEqual([
      {
        id: "devtools-bootstrap",
        html: '<script src="/api/devtools/bootstrap.js" defer></script>',
        position: "body-end",
      },
    ]);
    expect(plugin.getRuntimeConfigContribution()).toMatchObject({
      devtools: {
        enabledByDefault: false,
        bridgeTarget: "http://127.0.0.1:55107/context",
      },
    });
  });

  test("context endpoint enriches bundle with plugin metadata and recent events", async () => {
    const analyticsPlugin = new FakeAnalyticsPlugin({});
    const plugin = new DevtoolsPlugin({
      plugins: { analytics: analyticsPlugin },
    } as any);

    const middlewareHarness = createMiddlewareHarness();
    plugin.injectServerMiddleware(middlewareHarness.app);

    const middleware = middlewareHarness.getMiddleware();
    const eventReq = createMockRequest({
      method: "POST",
      path: "/api/analytics/query/demo",
      query: { requestId: "stream-123" },
      headers: {
        "x-appkit-devtools-session": "session-1",
      },
    });
    const eventRes = createEventResponse(200);

    middleware(eventReq, eventRes as any, vi.fn());
    eventRes.finish();

    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/context");
    const req = createMockRequest({
      body: {
        sessionId: "session-1",
        url: "http://localhost/analytics?foo=bar",
        title: "Analytics Overview",
        route: "/analytics",
        selectedText: "Revenue chart",
        selectedElement: {
          domPath: "main > section.analytics > button.refresh",
          selector: "button.refresh",
          tagName: "button",
          text: "Refresh",
        },
        textExcerpt: "Revenue dashboard with top contributors and usage trends",
        network: [
          {
            id: "net-1",
            method: "POST",
            url: "/api/analytics/query/demo",
            path: "/api/analytics/query/demo",
            status: 200,
            timestamp: new Date().toISOString(),
            durationMs: 32,
          },
        ],
        actions: [
          {
            type: "click",
            label: "Refresh analytics",
            timestamp: new Date().toISOString(),
            element: {
              domPath: "main > section.analytics > button.refresh",
              selector: "button.refresh",
              tagName: "button",
              text: "Refresh",
            },
          },
        ],
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        plugin: expect.objectContaining({
          name: "analytics",
          matchedBy: "pathname",
        }),
        page: expect.objectContaining({
          selectedText: "Revenue chart",
          selectedElement: expect.objectContaining({
            domPath: "main > section.analytics > button.refresh",
            selector: "button.refresh",
          }),
          recentActions: [
            expect.objectContaining({
              label: "Refresh analytics",
              element: expect.objectContaining({
                domPath: "main > section.analytics > button.refresh",
              }),
            }),
          ],
        }),
        client: expect.objectContaining({
          recentConsole: [],
        }),
        server: {
          recentEvents: [
            expect.objectContaining({
              path: "/api/analytics/query/demo",
              requestId: "stream-123",
              streamId: "stream-123",
            }),
          ],
        },
      }),
    );
  });

  test("prompt endpoint returns a prompt with relevant route details", async () => {
    const analyticsPlugin = new FakeAnalyticsPlugin({});
    const plugin = new DevtoolsPlugin({
      plugins: { analytics: analyticsPlugin },
    } as any);

    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/prompt");
    const req = createMockRequest({
      body: {
        sessionId: "session-2",
        url: "http://localhost/analytics",
        route: "/analytics",
        title: "Analytics",
        selectedElement: {
          domPath: "main > article.kpi-card",
          selector: "article.kpi-card",
          tagName: "article",
          text: "Revenue",
        },
        textExcerpt: "Revenue dashboard",
        network: [
          {
            id: "net-1",
            method: "POST",
            url: "/api/analytics/query/demo",
            path: "/api/analytics/query/demo",
            status: 200,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Selected element:"),
        bundle: expect.objectContaining({
          page: expect.objectContaining({
            route: "/analytics",
          }),
        }),
      }),
    );
    const promptResponse = res.json.mock.calls[0][0];
    expect(promptResponse.prompt).toContain(
      "Likely AppKit plugin: Analytics Plugin",
    );
  });

  test("bridge endpoint forwards a redacted bundle to a localhost target", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const plugin = new DevtoolsPlugin({
      bridgeTarget: "http://127.0.0.1:55107/context",
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/bridge");
    const req = createMockRequest({
      body: {
        sessionId: "session-3",
        url: "http://localhost/files?token=secret-value",
        route: "/files",
        title: "Files",
        textExcerpt: "Volume browser",
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:55107/context",
      expect.objectContaining({
        method: "POST",
      }),
    );

    const forwardedBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(decodeURIComponent(forwardedBody.app.url)).toContain("[redacted]");
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      status: 200,
      target: "http://127.0.0.1:55107/context",
    });
  });

  test("bridge endpoint gracefully handles non-localhost targets", async () => {
    const plugin = new DevtoolsPlugin({
      bridgeTarget: "https://example.com/context",
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);

    const handler = getHandler("POST", "/bridge");
    const req = createMockRequest({
      body: {
        sessionId: "session-4",
        url: "http://localhost/genie",
        route: "/genie",
      },
    });
    const res = createMockResponse();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        bridgeForwarded: false,
        stored: true,
      }),
    );
  });
});
