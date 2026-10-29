import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_QUERY_TAGS,
  resolveQueryTags,
  sanitizeQueryTags,
  withQueryTags,
} from "../query-tags";

describe("sanitizeQueryTags", () => {
  test("keeps valid string and key-only tags", () => {
    expect(
      sanitizeQueryTags(
        { team: "eng", page_name: "sales", exp: null },
        "client",
      ),
    ).toEqual({ team: "eng", page_name: "sales", exp: null });
  });

  test("drops keys with characters the warehouse rejects", () => {
    expect(
      sanitizeQueryTags(
        {
          "a,b": "x",
          "a:b": "x",
          "a-b": "x",
          "a/b": "x",
          "a=b": "x",
          "a.b": "x",
          "@@internal": "x",
          " ": "x",
          ok: "x",
        },
        "client",
      ),
    ).toEqual({ ok: "x" });
  });

  test("drops reserved appkit_ keys so attribution cannot be spoofed", () => {
    expect(
      sanitizeQueryTags({ appkit_app: "spoofed", team: "eng" }, "client"),
    ).toEqual({ team: "eng" });
  });

  test("drops non-string values and over-long keys, truncates long values", () => {
    const out = sanitizeQueryTags(
      { n: 1, o: { x: 1 }, ["k".repeat(129)]: "x", long: "v".repeat(500) },
      "client",
    );
    expect(out).toEqual({ long: "v".repeat(128) });
  });

  test("ignores non-object input", () => {
    for (const input of [undefined, null, "team:eng", ["team"], 42]) {
      expect(sanitizeQueryTags(input, "client")).toEqual({});
    }
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

  test("passes context, including sanitized client tags, to a function config", () => {
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
    expect(tags).toEqual([
      { key: "tenant", value: "acme" },
      { key: "page", value: "overview" },
    ]);
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
