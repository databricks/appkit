import { describe, expect, test } from "vitest";
import { InlineArrowStash } from "../inline-arrow-stash";

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

// `put()` returns `{ id, pool } | null` — it rejects with null when the stash
// is full. Most tests only care about the id; this helper narrows via the
// non-null contract and returns just the id. Tests that need the pool tag
// call `stash.put(...)` directly.
function mustPut(
  stash: InlineArrowStash,
  userId: string,
  b: Uint8Array,
): string {
  const result = stash.put(userId, b);
  if (result === null) {
    throw new Error("test setup: stash unexpectedly rejected put");
  }
  return result.id;
}

describe("InlineArrowStash", () => {
  test("put returns an inline-prefixed synthetic id", () => {
    const stash = new InlineArrowStash({ idGenerator: () => "abc" });
    const id = mustPut(stash, "user-1", bytes(100));
    expect(id).toBe("inline-abc");
  });

  test("take drains the entry", () => {
    const stash = new InlineArrowStash();
    const id = mustPut(stash, "user-1", bytes(100));
    expect(stash.count()).toBe(1);
    expect(stash.size()).toBe(100);

    const got = stash.take(id, "user-1");
    expect(got).toBeDefined();
    expect(got?.length).toBe(100);
    expect(stash.count()).toBe(0);
    expect(stash.size()).toBe(0);
    // Drain-on-read: second take returns undefined.
    expect(stash.take(id, "user-1")).toBeUndefined();
  });

  test("take returns undefined for unknown id", () => {
    const stash = new InlineArrowStash();
    expect(stash.take("inline-nope", "user-1")).toBeUndefined();
  });

  test("take returns undefined when userId does not match", () => {
    const stash = new InlineArrowStash();
    const id = mustPut(stash, "user-1", bytes(100));
    expect(stash.take(id, "user-2")).toBeUndefined();
    // Entry is still there for the right user.
    expect(stash.take(id, "user-1")).toBeDefined();
  });

  test("entries past TTL are evicted on next gc tick", () => {
    let clock = 0;
    // gcMinIntervalMs: 0 disables gc throttling so the test can drive
    // the clock past TTL on a sub-throttle scale without the gc pass
    // being skipped.
    const stash = new InlineArrowStash({
      ttlMs: 1000,
      gcMinIntervalMs: 0,
      now: () => clock,
    });
    const id = mustPut(stash, "user-1", bytes(50));
    clock = 999;
    expect(stash.take(id, "user-1")).toBeDefined();

    const id2 = mustPut(stash, "user-1", bytes(50));
    clock = 2000;
    // Bump the clock past TTL and trigger gc via another put.
    mustPut(stash, "user-2", bytes(10));
    expect(stash.take(id2, "user-1")).toBeUndefined();
  });

  test("put spills into the overflow pool when the regular pool is at cap — every issued id remains valid", () => {
    let seq = 0;
    const stash = new InlineArrowStash({
      maxBytes: 200,
      maxOverflowBytes: 200,
      idGenerator: () => String(seq++),
    });
    const a = mustPut(stash, "user-1", bytes(80));
    const b = mustPut(stash, "user-1", bytes(80));
    expect(stash.size()).toBe(160);
    expect(stash.overflowSize()).toBe(0);

    // The third 80-byte entry would push the regular pool to 240 (>200),
    // so it spills into overflow. Both prior entries must survive.
    const c = mustPut(stash, "user-1", bytes(80));
    expect(stash.size()).toBe(160);
    expect(stash.overflowSize()).toBe(80);
    expect(stash.take(a, "user-1")).toBeDefined();
    expect(stash.take(b, "user-1")).toBeDefined();
    expect(stash.take(c, "user-1")).toBeDefined();
    // After draining the overflow entry, the counter reflects it.
    expect(stash.overflowSize()).toBe(0);
  });

  test("put returns null only when both regular and overflow pools are full", () => {
    let seq = 0;
    const stash = new InlineArrowStash({
      maxBytes: 100,
      maxOverflowBytes: 100,
      idGenerator: () => String(seq++),
    });
    const a = mustPut(stash, "user-1", bytes(100)); // fills regular
    const b = mustPut(stash, "user-1", bytes(100)); // fills overflow
    expect(stash.size()).toBe(100);
    expect(stash.overflowSize()).toBe(100);

    // Both pools at cap — refuse rather than evict.
    const c = stash.put("user-1", bytes(50));
    expect(c).toBeNull();
    expect(stash.take(a, "user-1")).toBeDefined();
    expect(stash.take(b, "user-1")).toBeDefined();
  });

  test("put tags the result with its pool so callers can label telemetry without re-introspecting", () => {
    const stash = new InlineArrowStash({
      maxBytes: 100,
      maxOverflowBytes: 100,
    });
    expect(stash.put("u", bytes(80))).toMatchObject({ pool: "regular" });
    // Regular has 80/100 used; another 80 would push it to 160 > 100 so it
    // spills.
    expect(stash.put("u", bytes(80))).toMatchObject({ pool: "overflow" });
  });

  test("put throws when a single payload would not fit in the largest pool (caller misconfiguration)", () => {
    const stash = new InlineArrowStash({
      maxBytes: 100,
      maxOverflowBytes: 100,
    });
    // 300 > max(maxBytes, maxOverflowBytes) (100); pools don't split,
    // so no individual put can ever succeed.
    expect(() => stash.put("user-1", bytes(300))).toThrow(
      /exceeds largest stash slot/,
    );
  });

  test("overflow entries expire on a shorter TTL than regular entries", () => {
    let clock = 0;
    const stash = new InlineArrowStash({
      maxBytes: 80,
      maxOverflowBytes: 80,
      ttlMs: 600_000,
      overflowTtlMs: 30_000,
      gcMinIntervalMs: 0,
      now: () => clock,
    });
    const reg = mustPut(stash, "user-1", bytes(80)); // fills regular
    const ovf = mustPut(stash, "user-1", bytes(80)); // spills to overflow
    expect(stash.size()).toBe(80);
    expect(stash.overflowSize()).toBe(80);

    // 45 s in: overflow expired, regular still alive.
    clock = 45_000;
    expect(stash.take(ovf, "user-1")).toBeUndefined();
    expect(stash.take(reg, "user-1")).toBeDefined();
  });

  test("synthetic ids are unique across puts", () => {
    const stash = new InlineArrowStash();
    const a = mustPut(stash, "user-1", bytes(10));
    const b = mustPut(stash, "user-1", bytes(10));
    expect(a).not.toBe(b);
    expect(a.startsWith("inline-")).toBe(true);
    expect(b.startsWith("inline-")).toBe(true);
  });

  test("clear drops every entry", () => {
    const stash = new InlineArrowStash();
    mustPut(stash, "user-1", bytes(10));
    mustPut(stash, "user-2", bytes(20));
    stash.clear();
    expect(stash.count()).toBe(0);
    expect(stash.size()).toBe(0);
  });
});
