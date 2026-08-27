import { afterEach, describe, expect, test, vi } from "vitest";

import { CacheManager } from "../../cache";
import { InMemoryStorage } from "../../cache/storage";
import { ServiceContext } from "../../context";
import { AuthenticationError } from "../../errors";
import {
  createMockRequest,
  mockServiceContext,
  resetTestCache,
  useServiceContextMock,
  withEnv,
} from "../fixtures";

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

  test("no-ops when the cache is not initialized", async () => {
    // Force the uninitialized branch deterministically (there is no public
    // un-initialize), so the try/catch is exercised regardless of test order.
    vi.spyOn(CacheManager, "getInstanceSync").mockImplementation(() => {
      throw new Error("not initialized");
    });
    await expect(resetTestCache()).resolves.toBeUndefined();
  });

  test("clears a populated cache", async () => {
    // Seed the real singleton the way attach() does, then prove reset empties it.
    const cache = await CacheManager.getInstance({
      storage: new InMemoryStorage({}),
    });
    await cache.set("k", { hello: "world" });
    expect(await cache.get("k")).toEqual({ hello: "world" });

    await resetTestCache();

    expect(await cache.get("k")).toBeNull();
  });
});

describe("mockServiceContext — user context matches production", () => {
  test("the fingerprint is derived from the token, not the user", () => {
    // Lakebase rotates its pool by comparing this. A user-keyed value would be
    // constant across tokens, so `pool-manager` would never see a change and the
    // drain-and-recreate branch could never run under this fake.
    const mock = mockServiceContext();
    try {
      const fp = (token: string) =>
        ServiceContext.createUserContext(token, "same").tokenFingerprint;
      expect(fp("tok-a")).toBe(fp("tok-a"));
      expect(fp("tok-a")).not.toBe(fp("tok-b"));
      expect(fp("tok-a")).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      mock.restore();
    }
  });

  test("a missing token is refused, with production's error class", () => {
    const mock = mockServiceContext();
    try {
      expect(() => ServiceContext.createUserContext("", "nobody")).toThrow(
        AuthenticationError,
      );
    } finally {
      mock.restore();
    }
  });

  test("userEmail is carried through", () => {
    const mock = mockServiceContext();
    try {
      const ctx = ServiceContext.createUserContext(
        "tok",
        "u-1",
        "Alice",
        "alice@example.com",
      );
      expect(ctx.userEmail).toBe("alice@example.com");
    } finally {
      mock.restore();
    }
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

describe("withEnv — environment variable restoration", () => {
  test("sets a var inside fn, restores it to its prior value afterward", () => {
    const original = process.env.TEST_VAR;
    process.env.TEST_VAR = "original";

    const result = withEnv({ TEST_VAR: "modified" }, () => {
      expect(process.env.TEST_VAR).toBe("modified");
      return "done";
    });

    expect(result).toBe("done");
    expect(process.env.TEST_VAR).toBe("original");

    // Cleanup
    if (original === undefined) {
      delete process.env.TEST_VAR;
    } else {
      process.env.TEST_VAR = original;
    }
  });

  test("a key that was UNSET before is deleted (not left set) after fn returns", () => {
    if (process.env.NEVER_SET_VAR !== undefined) {
      delete process.env.NEVER_SET_VAR;
    }

    withEnv({ NEVER_SET_VAR: "temp" }, () => {
      expect(process.env.NEVER_SET_VAR).toBe("temp");
    });

    expect(process.env.NEVER_SET_VAR).toBeUndefined();
  });

  test("a key that PRE-EXISTED is restored to its original value, not deleted", () => {
    process.env.PRE_EXISTING = "before";

    withEnv({ PRE_EXISTING: "changed" }, () => {
      expect(process.env.PRE_EXISTING).toBe("changed");
    });

    expect(process.env.PRE_EXISTING).toBe("before");

    // Cleanup
    delete process.env.PRE_EXISTING;
  });

  test("restores even when fn throws", () => {
    process.env.THROW_TEST = "before";

    expect(() => {
      withEnv({ THROW_TEST: "during" }, () => {
        expect(process.env.THROW_TEST).toBe("during");
        throw new Error("test error");
      });
    }).toThrow("test error");

    expect(process.env.THROW_TEST).toBe("before");

    // Cleanup
    delete process.env.THROW_TEST;
  });

  test("async form: await withEnv({...}, async () => …) restores after the promise settles", async () => {
    process.env.ASYNC_TEST = "before";

    await withEnv({ ASYNC_TEST: "during" }, async () => {
      expect(process.env.ASYNC_TEST).toBe("during");
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(process.env.ASYNC_TEST).toBe("before");

    // Cleanup
    delete process.env.ASYNC_TEST;
  });

  test("async form restores even when the promise rejects", async () => {
    process.env.ASYNC_REJECT_TEST = "before";

    await expect(
      withEnv({ ASYNC_REJECT_TEST: "during" }, async () => {
        expect(process.env.ASYNC_REJECT_TEST).toBe("during");
        throw new Error("async error");
      }),
    ).rejects.toThrow("async error");

    expect(process.env.ASYNC_REJECT_TEST).toBe("before");

    // Cleanup
    delete process.env.ASYNC_REJECT_TEST;
  });

  test("nested withEnv calls restore in reverse order (LIFO)", () => {
    process.env.NESTED_VAR = "original";
    const log: string[] = [];

    withEnv({ NESTED_VAR: "level1" }, () => {
      log.push(`L1-during: ${process.env.NESTED_VAR}`);

      withEnv({ NESTED_VAR: "level2" }, () => {
        log.push(`L2-during: ${process.env.NESTED_VAR}`);
      });

      log.push(`L1-after: ${process.env.NESTED_VAR}`);
    });

    log.push(`outside: ${process.env.NESTED_VAR}`);

    expect(log).toEqual([
      "L1-during: level1",
      "L2-during: level2",
      "L1-after: level1",
      "outside: original",
    ]);

    // Cleanup
    delete process.env.NESTED_VAR;
  });
});
