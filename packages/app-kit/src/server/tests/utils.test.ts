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
  getQueries,
  getRoutes,
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
});
