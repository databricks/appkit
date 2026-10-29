import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_QUERY_TAGS,
  resolveQueryTags,
  sanitizeQueryTags,
  withQueryTags,
} from "../query-tags";

function sanitized(input: unknown, source: "client" | "config" = "client") {
  return Object.fromEntries(sanitizeQueryTags(input, source));
}

describe("sanitizeQueryTags", () => {
  test("keeps valid string and key-only tags", () => {
    expect(sanitized({ team: "eng", page_name: "sales", exp: null })).toEqual({
      team: "eng",
      page_name: "sales",
      exp: null,
    });
  });

  test("drops keys with characters the warehouse rejects", () => {
    expect(
      sanitized({
        "a,b": "x",
        "a:b": "x",
        "a-b": "x",
        "a/b": "x",
        "a=b": "x",
        "a.b": "x",
        "@@internal": "x",
        " ": "x",
        " lead": "x",
        "trail ": "x",
        "new\nline": "x",
        "tab\there": "x",
        ok: "x",
      }),
    ).toEqual({ ok: "x" });
  });

  test("drops reserved appkit_ keys so attribution cannot be spoofed", () => {
    expect(
      sanitized({ appkit_app: "spoofed", APPKIT_route: "x", team: "eng" }),
    ).toEqual({ team: "eng" });
  });

  test("drops non-string values and over-long keys, truncates long values", () => {
    const out = sanitized({
      n: 1,
      o: { x: 1 },
      ["k".repeat(129)]: "x",
      long: "v".repeat(500),
    });
    expect(out).toEqual({ long: "v".repeat(128) });
  });

  test("ignores non-object input", () => {
    for (const input of [undefined, null, "team:eng", ["team"], 42]) {
      expect(sanitized(input)).toEqual({});
    }
  });

  test("truncates by code point without splitting surrogate pairs", () => {
    const value = sanitized({ emoji: "😀".repeat(200) }).emoji as string;
    expect(Array.from(value)).toHaveLength(128);
    expect(value).toBe("😀".repeat(128));
  });

  test("keeps a JSON-parsed __proto__ key as a plain tag", () => {
    expect(
      sanitizeQueryTags(JSON.parse('{"__proto__":"exp"}'), "client").get(
        "__proto__",
      ),
    ).toBe("exp");
  });

  test("examines a bounded number of client entries", () => {
    const huge = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(sanitizeQueryTags(huge, "client").size).toBe(64);
  });

  test("logs only the dropped count, never client key names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sanitizeQueryTags({ "bad:\nFORGED": "x" }, "config");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("Dropped 1 invalid config query tag(s)");
    expect(logged).not.toContain("FORGED");
    warn.mockRestore();
  });
});

describe("resolveQueryTags", () => {
  const prevAppName = process.env.DATABRICKS_APP_NAME;

  beforeEach(() => {
    process.env.DATABRICKS_APP_NAME = "sales-dashboard";
  });

  afterEach(() => {
    if (prevAppName === undefined) delete process.env.DATABRICKS_APP_NAME;
    else process.env.DATABRICKS_APP_NAME = prevAppName;
  });

  test("adds automatic attribution tags by default", () => {
    expect(
      resolveQueryTags({}, { route: "query", queryKey: "revenue", lane: "sp" }),
    ).toEqual([
      { key: "appkit_app", value: "sales-dashboard" },
      { key: "appkit_query_key", value: "revenue" },
      { key: "appkit_route", value: "query" },
      { key: "appkit_lane", value: "sp" },
    ]);
  });

  test("omits appkit_app when the app name is unknown (local dev)", () => {
    delete process.env.DATABRICKS_APP_NAME;
    const tags = resolveQueryTags({}, { route: "agent_tool", lane: "obo" });
    expect(tags).toEqual([
      { key: "appkit_route", value: "agent_tool" },
      { key: "appkit_lane", value: "obo" },
    ]);
  });

  test("autoQueryTags: false disables automatic tags", () => {
    expect(
      resolveQueryTags(
        { autoQueryTags: false },
        { route: "query", queryKey: "revenue", lane: "sp" },
      ),
    ).toBeUndefined();
  });

  test("merges static config tags and client tags; server wins on collisions", () => {
    const tags = resolveQueryTags(
      { autoQueryTags: false, queryTags: { team: "finance" } },
      {
        route: "query",
        lane: "sp",
        clientTags: { team: "spoofed", page: "overview" },
      },
    );
    expect(tags).toEqual([
      { key: "team", value: "finance" },
      { key: "page", value: "overview" },
    ]);
  });

  test("clientQueryTags: false ignores client tags", () => {
    const tags = resolveQueryTags(
      { autoQueryTags: false, clientQueryTags: false },
      { route: "query", lane: "sp", clientTags: { page: "overview" } },
    );
    expect(tags).toBeUndefined();
  });

  test("passes context, including validated client tags, to a function config", () => {
    const queryTags = vi.fn().mockReturnValue({ tenant: "acme" });
    const tags = resolveQueryTags(
      { autoQueryTags: false, queryTags },
      {
        route: "metric",
        queryKey: "orders",
        lane: "obo",
        clientTags: { page: "overview", "bad.key": "x" },
      },
    );
    expect(queryTags).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "metric",
        queryKey: "orders",
        lane: "obo",
        clientTags: { page: "overview" },
      }),
    );
    // The function's return value is the whole custom set: client tags it
    // didn't return are not sent.
    expect(tags).toEqual([{ key: "tenant", value: "acme" }]);
  });

  test("a function config that returns nothing drops client tags", () => {
    // The docs' conditional-tenant example: no header means no tenant, and a
    // client must not be able to fill the gap.
    const tags = resolveQueryTags(
      {
        queryTags: ({ req }) => {
          const tenant = req?.header("x-tenant");
          return tenant ? { tenant } : undefined;
        },
      },
      {
        route: "query",
        queryKey: "revenue",
        lane: "sp",
        clientTags: { tenant: "acme", page: "overview" },
      },
    );
    expect(tags?.map((t) => t.key)).toEqual([
      "appkit_app",
      "appkit_query_key",
      "appkit_route",
      "appkit_lane",
    ]);
  });

  test("a function config can pass client tags through", () => {
    const tags = resolveQueryTags(
      {
        autoQueryTags: false,
        queryTags: ({ clientTags }) => ({ ...clientTags, team: "finance" }),
      },
      { route: "query", lane: "sp", clientTags: { page: "overview" } },
    );
    expect(tags).toEqual([
      { key: "page", value: "overview" },
      { key: "team", value: "finance" },
    ]);
  });

  test("a function config returning a non-object adds no tags", () => {
    const tags = resolveQueryTags(
      { autoQueryTags: false, queryTags: () => "team:eng" as never },
      { route: "query", lane: "sp" },
    );
    expect(tags).toBeUndefined();
  });

  test("an invalid static config warns once, not per statement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = { queryTags: { "cost-center": "x", team: "eng" } };
    for (let i = 0; i < 3; i++) {
      resolveQueryTags(config, { route: "query", lane: "sp" });
    }
    const drops = warn.mock.calls.filter((call) =>
      call.join(" ").includes("Dropped"),
    );
    expect(drops).toHaveLength(1);
    warn.mockRestore();
  });

  test("a throwing function config never fails the query", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tags = resolveQueryTags(
      {
        queryTags: () => {
          throw new Error("boom");
        },
      },
      { route: "query", queryKey: "revenue", lane: "sp" },
    );
    expect(tags?.map((t) => t.key)).toEqual([
      "appkit_app",
      "appkit_query_key",
      "appkit_route",
      "appkit_lane",
    ]);
    warn.mockRestore();
  });

  test("integer-like client keys cannot push out automatic tags", () => {
    const numeric = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [String(i), "v"]),
    );
    const tags = resolveQueryTags(
      {},
      { route: "query", queryKey: "q", lane: "sp", clientTags: numeric },
    );
    expect(tags).toHaveLength(MAX_QUERY_TAGS);
    expect(tags?.slice(0, 4).map((t) => t.key)).toEqual([
      "appkit_app",
      "appkit_query_key",
      "appkit_route",
      "appkit_lane",
    ]);
  });

  test("caps at the warehouse limit, keeping automatic tags first", () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, "v"]),
    );
    const tags = resolveQueryTags(
      {},
      { route: "query", queryKey: "q", lane: "sp", clientTags: many },
    );
    expect(tags).toHaveLength(MAX_QUERY_TAGS);
    expect(tags?.slice(0, 4).map((t) => t.key)).toEqual([
      "appkit_app",
      "appkit_query_key",
      "appkit_route",
      "appkit_lane",
    ]);
  });
});

describe("withQueryTags", () => {
  test("adds queryTags to every statement's format parameters", async () => {
    const query = vi.fn().mockResolvedValue({ data: [] });
    const queryTags = [{ key: "team", value: "eng" }];
    const signal = new AbortController().signal;

    await withQueryTags({ query }, queryTags).query(
      "SELECT 1",
      undefined,
      { disposition: "INLINE", format: "JSON_ARRAY" },
      signal,
    );

    expect(query).toHaveBeenCalledWith(
      "SELECT 1",
      undefined,
      { disposition: "INLINE", format: "JSON_ARRAY", queryTags },
      signal,
    );
  });

  test("returns the executor unchanged when there are no tags", () => {
    const executor = { query: vi.fn() };
    expect(withQueryTags(executor, undefined)).toBe(executor);
  });
});
