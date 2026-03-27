import { describe, expect, test, vi } from "vitest";

const { mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReaddirSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  },
}));

import {
  generateTunnelIdFromEmail,
  getConfigScript,
  getQueries,
  getRoutes,
  getRuntimeConfig,
  parseCookies,
} from "../utils";

describe("server/utils", () => {
  test("parseCookies returns {} when no cookie header", () => {
    const req = { headers: {} } as any;
    expect(parseCookies(req)).toEqual({});
  });

  test("parseCookies parses a single cookie (fast path)", () => {
    const req = { headers: { cookie: "a=b" } } as any;
    expect(parseCookies(req)).toEqual({ a: "b" });
  });

  test("parseCookies parses multiple cookies", () => {
    const req = { headers: { cookie: "a=b; c=d; e=f" } } as any;
    expect(parseCookies(req)).toEqual({ a: "b", c: "d", e: "f" });
  });

  test("generateTunnelIdFromEmail is deterministic and 8 chars", () => {
    const id1 = generateTunnelIdFromEmail("x@y.com");
    const id2 = generateTunnelIdFromEmail("x@y.com");
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(8);
  });

  test("generateTunnelIdFromEmail returns undefined for empty input", () => {
    expect(generateTunnelIdFromEmail(undefined)).toBeUndefined();
  });

  test("getRoutes returns flat + nested router routes with proper base path", () => {
    const stack: any[] = [
      {
        route: {
          path: "/health",
          methods: { get: true },
        },
      },
      {
        name: "router",
        handle: {
          stack: [
            {
              route: {
                path: "/echo",
                methods: { post: true },
              },
            },
          ],
        },
        regexp: {
          // Express-style source is usually "^\\/api\\/?(?=\\/|$)"
          source: "^\\/api\\/?(?=\\/|$)",
        },
      },
    ];

    expect(getRoutes(stack)).toEqual([
      { path: "/health", methods: ["GET"] },
      { path: "/api/echo", methods: ["POST"] },
    ]);
  });

  test("getQueries returns {} when queries folder does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getQueries("/cfg")).toEqual({});
  });

  test("getQueries returns sql basenames", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["a.sql", "b.txt", "c.sql"]);

    expect(getQueries("/cfg")).toEqual({ a: "a", c: "c" });
  });

  describe("getRuntimeConfig", () => {
    test("includes empty plugins by default", () => {
      mockExistsSync.mockReturnValue(false);
      const config = getRuntimeConfig();
      expect(config.plugins).toEqual({});
    });

    test("includes plugin configs when provided", () => {
      mockExistsSync.mockReturnValue(false);
      const pluginConfigs = {
        analytics: { trackingId: "UA-123" },
        genie: { spaceId: "space-1" },
      };
      const config = getRuntimeConfig({}, pluginConfigs);
      expect(config.plugins).toEqual(pluginConfigs);
    });
  });

  describe("getConfigScript", () => {
    test("serializes plugin configs into inert JSON script tag", () => {
      mockExistsSync.mockReturnValue(false);
      const pluginConfigs = { myPlugin: { key: "value" } };
      const script = getConfigScript({}, pluginConfigs);

      expect(script).toContain('type="application/json"');
      expect(script).toContain('"myPlugin"');
      expect(script).toContain('"key":"value"');
    });

    test("produces valid JSON with empty plugin configs", () => {
      mockExistsSync.mockReturnValue(false);
      const script = getConfigScript();

      expect(script).toContain('"plugins":{}');
    });

    test("escapes script-breaking characters in runtime config JSON", () => {
      mockExistsSync.mockReturnValue(false);
      const script = getConfigScript(
        {},
        {
          myPlugin: {
            message: "</script><script>alert('xss')</script>",
          },
        },
      );

      expect(script).toContain("\\u003c/script\\u003e");
      expect(script).not.toContain("</script><script>alert('xss')</script>");
      expect(script).toContain("window.__appkit__ = JSON.parse");
    });
  });
});
