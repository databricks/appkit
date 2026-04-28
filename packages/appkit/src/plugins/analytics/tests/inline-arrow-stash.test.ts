import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InlineArrowStash } from "../inline-arrow-stash";

describe("InlineArrowStash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns a fresh inline-prefixed id for each put", () => {
    const stash = new InlineArrowStash();
    const id1 = stash.put(Buffer.from("a"));
    const id2 = stash.put(Buffer.from("b"));
    expect(id1).toMatch(/^inline-/);
    expect(id2).toMatch(/^inline-/);
    expect(id1).not.toBe(id2);
  });

  test("take() returns the buffer exactly once (one-shot)", () => {
    const stash = new InlineArrowStash();
    const buf = Buffer.from([1, 2, 3]);
    const id = stash.put(buf);

    const first = stash.take(id);
    expect(first).toBeInstanceOf(Buffer);
    expect(Array.from(first as Buffer)).toEqual([1, 2, 3]);

    const second = stash.take(id);
    expect(second).toBeNull();
  });

  test("take() returns null for non-existent ids", () => {
    const stash = new InlineArrowStash();
    expect(stash.take("inline-does-not-exist")).toBeNull();
  });

  test("take() returns null for ids without the inline- prefix (treated as warehouse id)", () => {
    const stash = new InlineArrowStash();
    // Even after stashing, a take() on a non-inline id is rejected — the
    // route handler relies on this to forward un-prefixed ids to the
    // warehouse fetch path.
    stash.put(Buffer.from("x"));
    expect(stash.take("01234567-real-warehouse-statement-id")).toBeNull();
  });

  test("take() returns null after TTL expires", () => {
    const stash = new InlineArrowStash({ ttlMs: 1000 });
    const id = stash.put(Buffer.from("data"));
    vi.advanceTimersByTime(1500);
    expect(stash.take(id)).toBeNull();
  });

  test("take() succeeds within TTL", () => {
    const stash = new InlineArrowStash({ ttlMs: 1000 });
    const id = stash.put(Buffer.from("data"));
    vi.advanceTimersByTime(500);
    expect(stash.take(id)).toBeInstanceOf(Buffer);
  });

  test("LRU evicts oldest entry when maxEntries is reached", () => {
    const stash = new InlineArrowStash({ maxEntries: 2 });
    const id1 = stash.put(Buffer.from("a"));
    const id2 = stash.put(Buffer.from("b"));
    const id3 = stash.put(Buffer.from("c")); // forces eviction of id1

    expect(stash.size()).toBe(2);
    expect(stash.take(id1)).toBeNull();
    expect(stash.take(id2)).not.toBeNull();
    expect(stash.take(id3)).not.toBeNull();
  });

  test("expired entries are dropped on next put (passive cleanup)", () => {
    const stash = new InlineArrowStash({ ttlMs: 1000, maxEntries: 5 });
    const id1 = stash.put(Buffer.from("old"));
    vi.advanceTimersByTime(1500);

    const id2 = stash.put(Buffer.from("new"));
    // The expired id1 entry should have been evicted, so size() reflects
    // only the newly-put entry.
    expect(stash.size()).toBe(1);
    expect(stash.take(id1)).toBeNull();
    expect(stash.take(id2)).not.toBeNull();
  });

  test("clear() empties the stash", () => {
    const stash = new InlineArrowStash();
    stash.put(Buffer.from("a"));
    stash.put(Buffer.from("b"));
    expect(stash.size()).toBe(2);
    stash.clear();
    expect(stash.size()).toBe(0);
  });

  test("ids are unguessable (UUID-backed)", () => {
    // Smoke-check: 1000 ids should all be distinct, well-formed.
    const stash = new InlineArrowStash({ maxEntries: 1000 });
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(stash.put(Buffer.from([i & 0xff])));
    }
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      // inline-<uuidv4>: 7-char prefix + 36-char UUID
      expect(id).toMatch(
        /^inline-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});
