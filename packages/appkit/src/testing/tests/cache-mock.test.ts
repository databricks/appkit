import { describe, expect, test, vi } from "vitest";

import { createCacheMock } from "../cache-mock";

describe("createCacheMock", () => {
  test("getOrExecute passes through to the fn (no caching, runs every call)", async () => {
    const mock = createCacheMock();
    const fn = vi.fn(async () => "result");

    await expect(mock.getOrExecute(["k"], fn, "user")).resolves.toBe("result");
    await mock.getOrExecute(["k"], fn, "user");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("exposes the cache-instance methods suites reference as spies", () => {
    const mock = createCacheMock() as Record<string, unknown>;
    for (const method of [
      "get",
      "set",
      "delete",
      "getOrExecute",
      "generateKey",
    ]) {
      expect(vi.isMockFunction(mock[method])).toBe(true);
    }
  });
});
