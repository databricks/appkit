import { afterEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context";
import {
  createMockRequest,
  resetTestCache,
  useServiceContextMock,
} from "../fixtures";
import { createTestPluginContext } from "../test-plugin-context";

describe("createMockRequest — obo option", () => {
  test("no obo leaves the forwarded identity headers unset", () => {
    const req = createMockRequest();
    expect(req.header("x-forwarded-access-token")).toBeUndefined();
    expect(req.header("x-forwarded-user")).toBeUndefined();
  });

  test("obo: true sets the default test identity headers", () => {
    const req = createMockRequest({ obo: true });
    expect(req.header("x-forwarded-access-token")).toBe("test-user-token");
    expect(req.header("x-forwarded-user")).toBe("test-user");
    // email is omitted unless asked for.
    expect(req.header("x-forwarded-email")).toBeUndefined();
  });

  test("obo object picks the identity, including email", () => {
    const req = createMockRequest({
      obo: { userId: "alice", token: "tok-1", email: "alice@example.com" },
    });
    expect(req.header("x-forwarded-user")).toBe("alice");
    expect(req.header("x-forwarded-access-token")).toBe("tok-1");
    expect(req.header("x-forwarded-email")).toBe("alice@example.com");
  });

  test("case-insensitive header lookup mirrors Express", () => {
    const req = createMockRequest({
      obo: { userId: "bob" },
      headers: { "Content-Type": "application/json" },
    });
    expect(req.header("X-Forwarded-User")).toBe("bob");
    // Stored lowercased, as Node hands them to Express — `header()` lowercases
    // the lookup, so a stored mixed-case key would be unreachable.
    expect(Object.keys(req.headers)).toEqual(
      Object.keys(req.headers).map((k) => k.toLowerCase()),
    );
  });

  test.each([
    ["lowercase", "x-forwarded-user"],
    ["mixed-case", "X-Forwarded-User"],
  ])(
    "an explicit %s override wins over the obo-generated header",
    (_c, key) => {
      const req = createMockRequest({
        obo: { userId: "alice" },
        headers: { [key]: "override" },
      });
      // The explicit override wins; the obo token it did not touch remains.
      expect(req.header("x-forwarded-user")).toBe("override");
      expect(req.header("x-forwarded-access-token")).toBe("test-user-token");
    },
  );

  test("other overrides (params, body) still apply alongside obo", () => {
    const req = createMockRequest({
      obo: true,
      params: { alias: "demo" },
      body: { content: "hi" },
    });
    expect(req.params).toEqual({ alias: "demo" });
    expect(req.body).toEqual({ content: "hi" });
    expect(req.header("x-forwarded-user")).toBe("test-user");
  });
});

describe("resetTestCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no-ops when this file has no kit cache to clear", async () => {
    await expect(resetTestCache()).resolves.toBeUndefined();
  });

  test("clears the cache a test context carries", async () => {
    const mock = createTestPluginContext();
    const key = mock.cache.generateKey(["k"], "user");
    await mock.cache.set(key, { hello: "world" });
    expect(await mock.cache.get(key)).toEqual({ hello: "world" });

    await resetTestCache();

    expect(await mock.cache.get(key)).toBeNull();
  });

  test("clears every kit cache in the file, not just the newest", async () => {
    // A file can hold several contexts, so "the most recent one" would clear
    // the wrong cache when called mid-test.
    const first = createTestPluginContext();
    const second = createTestPluginContext();
    const firstKey = first.cache.generateKey(["a"], "user");
    const secondKey = second.cache.generateKey(["b"], "user");
    await first.cache.set(firstKey, { n: 1 });
    await second.cache.set(secondKey, { n: 2 });

    await resetTestCache();

    expect(await first.cache.get(firstKey)).toBeNull();
    expect(await second.cache.get(secondKey)).toBeNull();
  });

  test("clears only the target it is given", async () => {
    const kept = createTestPluginContext();
    const cleared = createTestPluginContext();
    const keptKey = kept.cache.generateKey(["keep"], "user");
    const clearedKey = cleared.cache.generateKey(["drop"], "user");
    await kept.cache.set(keptKey, { n: 1 });
    await cleared.cache.set(clearedKey, { n: 2 });

    await resetTestCache(cleared);

    expect(await cleared.cache.get(clearedKey)).toBeNull();
    expect(await kept.cache.get(keptKey)).toEqual({ n: 1 });
  });

  test("accepts a manager directly as well as a handle", async () => {
    const mock = createTestPluginContext();
    const key = mock.cache.generateKey(["direct"], "user");
    await mock.cache.set(key, { n: 1 });

    await resetTestCache(mock.cache);

    expect(await mock.cache.get(key)).toBeNull();
  });
});

describe("useServiceContextMock", () => {
  const ctx = useServiceContextMock({ warehouseId: "wh-1" });

  test(".current exposes the active mock, installed for this test", () => {
    // The spy is live: the real singleton getter is replaced.
    expect(vi.isMockFunction(ServiceContext.get)).toBe(true);
    expect(ctx.current.serviceContext.serviceUserId).toBe("test-service-user");
    // Record a call so the next test can prove it did NOT leak across the
    // afterEach restore + fresh beforeEach install.
    ServiceContext.get();
    expect(ctx.current.getSpy).toHaveBeenCalledTimes(1);
  });

  test("each test gets a FRESH mock (the accessor is live, not a snapshot)", () => {
    // If `.current` returned a stale handle from the first test, this spy would
    // already show the call recorded above. A fresh install starts at zero.
    expect(ctx.current.getSpy).toHaveBeenCalledTimes(0);
    // And options are re-applied each time.
    expect(vi.isMockFunction(ServiceContext.get)).toBe(true);
  });
});

describe("useServiceContextMock — restores after the block", () => {
  // A nested block that uses the hook; after it, the real method is back.
  describe("inner", () => {
    useServiceContextMock();
    test("spies while active", () => {
      expect(vi.isMockFunction(ServiceContext.isInitialized)).toBe(true);
    });
  });

  test("the singleton is un-spied outside the hooked block", () => {
    // afterEach in the inner block restored the original method.
    expect(vi.isMockFunction(ServiceContext.isInitialized)).toBe(false);
  });
});
