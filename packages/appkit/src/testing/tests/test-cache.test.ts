import { describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../cache";
import { useTestCache } from "../test-cache";

describe("useTestCache", () => {
  const testCache = useTestCache();

  test("boots the cache and exposes it inside a test", () => {
    expect(testCache.current).toBeInstanceOf(CacheManager);
  });

  test("generateKey is production's key fn: stable for equal parts, differs by userKey", () => {
    const a = testCache.current.generateKey(["op", 1], "user-1");
    const b = testCache.current.generateKey(["op", 1], "user-1");
    const c = testCache.current.generateKey(["op", 1], "user-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("getOrExecute caches: same key runs fn once, different keys run it twice", async () => {
    const fn = vi.fn(async () => "value");
    await testCache.current.getOrExecute(["op", 1], fn, "user-1");
    await testCache.current.getOrExecute(["op", 1], fn, "user-1");
    expect(fn).toHaveBeenCalledTimes(1);

    const fn2 = vi.fn(async () => "value2");
    await testCache.current.getOrExecute(["op", 2], fn2, "user-1");
    await testCache.current.getOrExecute(["op", 3], fn2, "user-1");
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  test("is spy-able: getOrExecute records the key parts a caller passes", async () => {
    const spy = vi.spyOn(testCache.current, "getOrExecute");
    await testCache.current.getOrExecute(
      ["listing", "/a"],
      async () => 1,
      "svc",
    );
    expect(spy).toHaveBeenCalledWith(
      ["listing", "/a"],
      expect.any(Function),
      "svc",
    );
  });
});

// Proves the per-test clear: these two tests run in source order (Vitest's
// default within a file), and the second must not see the first's write.
describe("useTestCache clears between tests", () => {
  const testCache = useTestCache();
  const parts = ["shared"];
  const user = "u";

  test("writes a value", async () => {
    const key = testCache.current.generateKey(parts, user);
    await testCache.current.set(key, "first");
    expect(await testCache.current.get(key)).toBe("first");
  });

  test("does not see the previous test's value", async () => {
    const key = testCache.current.generateKey(parts, user);
    expect(await testCache.current.get(key)).toBeNull();
  });
});

describe("useTestCache keeps the singleton", () => {
  useTestCache();

  test("getInstanceSync still returns an instance during a test", () => {
    expect(() => CacheManager.getInstanceSync()).not.toThrow();
  });
});
