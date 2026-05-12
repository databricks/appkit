import { describe, expect, test } from "vitest";
import { InlineArrowStash } from "../inline-arrow-stash";

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

// `put()` returns `string | null` — it rejects with null when the stash is
// full. Every test below that exercises a successful put narrows via this
// helper so the non-null contract is explicit at the call site.
function mustPut(
  stash: InlineArrowStash,
  userId: string,
  b: Uint8Array,
): string {
  const id = stash.put(userId, b);
  if (id === null) {
    throw new Error("test setup: stash unexpectedly rejected put");
  }
  return id;
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
    const stash = new InlineArrowStash({ ttlMs: 1000, now: () => clock });
    const id = mustPut(stash, "user-1", bytes(50));
    clock = 999;
    expect(stash.take(id, "user-1")).toBeDefined();

    const id2 = mustPut(stash, "user-1", bytes(50));
    clock = 2000;
    // Bump the clock past TTL and trigger gc via another put.
    mustPut(stash, "user-2", bytes(10));
    expect(stash.take(id2, "user-1")).toBeUndefined();
  });

  test("put returns null when adding the payload would exceed maxBytes, leaving existing entries intact", () => {
    let seq = 0;
    const stash = new InlineArrowStash({
      maxBytes: 200,
      idGenerator: () => String(seq++),
    });
    const a = mustPut(stash, "user-1", bytes(80));
    const b = mustPut(stash, "user-1", bytes(80));
    expect(stash.size()).toBe(160);

    // This third 80-byte entry would push total to 240 (>200). It must
    // be rejected, and both prior entries must survive — every id we have
    // already handed out stays valid until drained or expired.
    const c = stash.put("user-1", bytes(80));
    expect(c).toBeNull();
    expect(stash.size()).toBe(160);
    expect(stash.take(a, "user-1")).toBeDefined();
    expect(stash.take(b, "user-1")).toBeDefined();
  });

  test("put throws for a single payload larger than maxBytes (caller misconfiguration)", () => {
    const stash = new InlineArrowStash({ maxBytes: 100 });
    expect(() => stash.put("user-1", bytes(200))).toThrow(
      /exceeds stash maxBytes/,
    );
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
