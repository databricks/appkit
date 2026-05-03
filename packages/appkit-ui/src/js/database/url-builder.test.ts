import { describe, expect, test } from "vitest";
import {
  buildUrl,
  EMPTY_STATE,
  pushFilter,
  pushInclude,
  pushOrder,
  pushSelect,
  type RequestState,
} from "./url-builder";

describe("pushFilter", () => {
  test("treats bare values as equality", () => {
    const next = pushFilter(EMPTY_STATE, { role: "admin", age: 30 });

    expect(next.filters).toEqual([
      { col: "role", expr: "eq.admin" },
      { col: "age", expr: "eq.30" },
    ]);
  });

  test("expands operator objects", () => {
    const next = pushFilter(EMPTY_STATE, {
      age: { gte: 18, lt: 65 },
    });

    expect(next.filters).toEqual([
      { col: "age", expr: "gte.18" },
      { col: "age", expr: "lt.65" },
    ]);
  });

  test("serializes `in` with a parenthesized list", () => {
    const next = pushFilter(EMPTY_STATE, {
      role: { in: ["admin", "owner"] },
    });

    expect(next.filters).toEqual([{ col: "role", expr: "in.(admin,owner)" }]);
  });

  test("serializes bare arrays as `in`", () => {
    const next = pushFilter(EMPTY_STATE, {
      status: ["new", "in_progress"],
    });

    expect(next.filters).toEqual([
      { col: "status", expr: "in.(new,in_progress)" },
    ]);
  });

  test("uses `is` for explicit null checks", () => {
    const next = pushFilter(EMPTY_STATE, {
      deletedAt: { is: null },
    });

    expect(next.filters).toEqual([{ col: "deletedAt", expr: "is.null" }]);
  });

  test("quotes string values with commas, spaces, or parens", () => {
    const next = pushFilter(EMPTY_STATE, {
      name: "Doe, Jane",
    });

    expect(next.filters).toEqual([{ col: "name", expr: 'eq."Doe, Jane"' }]);
  });

  test("skips undefined operator values", () => {
    const next = pushFilter(EMPTY_STATE, {
      age: { gte: undefined, lt: 65 },
    });

    expect(next.filters).toEqual([{ col: "age", expr: "lt.65" }]);
  });

  test("returns a new state object (immutable)", () => {
    const state = pushFilter(EMPTY_STATE, { role: "admin" });
    const next = pushFilter(state, { team: "ops" });

    expect(state.filters).toEqual([{ col: "role", expr: "eq.admin" }]);
    expect(next.filters).toHaveLength(2);
    expect(next).not.toBe(state);
  });
});

describe("pushOrder", () => {
  test("formats single-column order with default asc", () => {
    const next = pushOrder(EMPTY_STATE, { createdAt: "asc" });

    expect(next.order).toBe("createdAt.asc");
  });

  test("merges successive order calls", () => {
    const first = pushOrder(EMPTY_STATE, { createdAt: "desc" });
    const next = pushOrder(first, { id: "asc" });

    expect(next.order).toBe("createdAt.desc,id.asc");
  });

  test("is a no-op for empty input", () => {
    const next = pushOrder(EMPTY_STATE, {});

    expect(next).toBe(EMPTY_STATE);
  });
});

describe("pushSelect", () => {
  test("joins columns with commas", () => {
    const next = pushSelect(EMPTY_STATE, ["id", "email"]);

    expect(next.select).toBe("id,email");
  });

  test("is a no-op for empty projection", () => {
    const next = pushSelect(EMPTY_STATE, []);

    expect(next).toBe(EMPTY_STATE);
  });
});

describe("pushInclude", () => {
  test("serializes `{ posts: true }` with star projection", () => {
    const next = pushInclude(EMPTY_STATE, { posts: true });

    expect(next.select).toBe("*,posts(*)");
  });

  test("merges include with existing typed select", () => {
    const withSelect = pushSelect(EMPTY_STATE, ["id", "email"]);
    const next = pushInclude(withSelect, { posts: true });

    expect(next.select).toBe("id,email,posts(*)");
  });

  test("renders per-relation column list", () => {
    const next = pushInclude(EMPTY_STATE, {
      posts: { select: ["id", "title"] },
    });

    expect(next.select).toBe("*,posts(id,title)");
  });

  test("combines multiple relations", () => {
    const next = pushInclude(EMPTY_STATE, {
      posts: true,
      author: { select: ["id"] },
    });

    expect(next.select).toBe("*,posts(*),author(id)");
  });

  test("is a no-op when input is empty", () => {
    const next = pushInclude(EMPTY_STATE, {});

    expect(next).toBe(EMPTY_STATE);
  });
});

describe("buildUrl", () => {
  test("emits path only when state is empty", () => {
    expect(buildUrl("/api/database", "user", EMPTY_STATE)).toBe(
      "/api/database/user",
    );
  });

  test("appends filters and limit in a stable order", () => {
    const state: RequestState = {
      filters: [
        { col: "role", expr: "eq.admin" },
        { col: "age", expr: "gte.18" },
      ],
      limit: 10,
    };

    expect(buildUrl("/api/database", "user", state)).toBe(
      "/api/database/user?role=eq.admin&age=gte.18&limit=10",
    );
  });

  test("includes order, offset, and select when present", () => {
    const state: RequestState = {
      filters: [],
      order: "id.desc",
      offset: 20,
      select: "*,posts(*)",
    };

    expect(buildUrl("/api/database", "user", state)).toBe(
      "/api/database/user?order=id.desc&offset=20&select=*%2Cposts%28*%29",
    );
  });

  test("trims trailing slash from base url via caller contract", () => {
    // buildUrl itself does not normalize; the client wrapper is responsible.
    // This test documents that assumption.
    const state: RequestState = { filters: [] };

    expect(buildUrl("/api/database/", "user", state)).toBe(
      "/api/database//user",
    );
  });
});
