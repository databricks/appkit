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

  describe("putBlocking backpressure", () => {
    test("succeeds immediately when capacity is available", async () => {
      const stash = new InlineArrowStash({
        putWaitMs: 50,
        idGenerator: () => "x",
      });
      const id = await stash.putBlocking("user-1", bytes(10));
      expect(id).toBe("inline-x");
    });

    test("waits for a take() to free a slot, then succeeds", async () => {
      let seq = 0;
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 500,
        idGenerator: () => String(seq++),
      });
      const a = mustPut(stash, "user-1", bytes(80));
      mustPut(stash, "user-1", bytes(20));
      expect(stash.size()).toBe(100);

      // 50 bytes won't fit until something drains.
      const pending = stash.putBlocking("user-1", bytes(50));
      // Drain the 80-byte entry → frees room for 50.
      stash.take(a, "user-1");

      const id = await pending;
      expect(id).not.toBeNull();
      expect(stash.size()).toBe(70); // 20 left over + 50 just inserted
    });

    test("returns null when the wait elapses without a slot freeing", async () => {
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 20,
      });
      mustPut(stash, "user-1", bytes(100));
      const t0 = Date.now();
      const id = await stash.putBlocking("user-1", bytes(50));
      const elapsed = Date.now() - t0;
      expect(id).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });

    test("preserves FIFO order across waiters", async () => {
      let seq = 0;
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 500,
        idGenerator: () => String(seq++),
      });
      const a = mustPut(stash, "user-1", bytes(100));

      // A1 needs 60, A2 needs 30, both wait.
      const a1 = stash.putBlocking("user-1", bytes(60));
      const a2 = stash.putBlocking("user-1", bytes(30));

      stash.take(a, "user-1"); // frees 100 → both fit
      const [id1, id2] = await Promise.all([a1, a2]);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      // Order of issued ids matches submission order.
      expect(Number(id1!.replace("inline-", ""))).toBeLessThan(
        Number(id2!.replace("inline-", "")),
      );
    });

    test("rejects later waiters when head consumes the freed capacity", async () => {
      let seq = 0;
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 30,
        idGenerator: () => String(seq++),
      });
      const a = mustPut(stash, "user-1", bytes(100));

      const a1 = stash.putBlocking("user-1", bytes(80));
      const a2 = stash.putBlocking("user-1", bytes(80));

      stash.take(a, "user-1"); // 100 free → only a1 (80) fits
      const [id1, id2] = await Promise.all([a1, a2]);
      expect(id1).not.toBeNull();
      // a2 was still queued, gets evicted on timeout
      expect(id2).toBeNull();
    });

    test("settles with null when signal aborts mid-wait", async () => {
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 5000,
      });
      mustPut(stash, "user-1", bytes(100));
      const ac = new AbortController();
      const pending = stash.putBlocking("user-1", bytes(50), ac.signal);
      ac.abort();
      expect(await pending).toBeNull();
    });

    test("pre-aborted signal short-circuits", async () => {
      const stash = new InlineArrowStash({
        maxBytes: 100,
        putWaitMs: 5000,
      });
      mustPut(stash, "user-1", bytes(100));
      const id = await stash.putBlocking(
        "user-1",
        bytes(50),
        AbortSignal.abort(),
      );
      expect(id).toBeNull();
    });

    test("putWaitMs=0 (default) behaves like sync put", async () => {
      const stash = new InlineArrowStash({ maxBytes: 100 });
      mustPut(stash, "user-1", bytes(100));
      const id = await stash.putBlocking("user-1", bytes(50));
      expect(id).toBeNull();
    });
  });
});
