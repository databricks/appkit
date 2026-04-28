import { randomUUID } from "node:crypto";

/**
 * Bounded TTL stash of inline Arrow IPC payloads, keyed by a synthetic
 * statement ID prefixed with `inline-`.
 *
 * The analytics route puts each ARROW_STREAM + INLINE response into the stash
 * and emits `{ type: "arrow", statement_id: <inline-...> }` over SSE. The
 * client fetches the bytes via the existing `/arrow-result/:jobId` endpoint,
 * which checks this stash first and only delegates to the warehouse fetch
 * when the ID is not stashed (i.e., a real EXTERNAL_LINKS statement).
 *
 * Decoupling bulk bytes from the SSE channel keeps `streamDefaults.maxEventSize`
 * small (control messages stay small), at the cost of in-process memory for
 * the duration of the round trip.
 *
 * Bounds:
 * - per-entry size: enforced upstream by the connector (`MAX_INLINE_ATTACHMENT_BYTES`).
 * - max entries: LRU-evict when full.
 * - TTL: time after which an unread entry is dropped.
 *
 * Reads are one-shot — `take()` removes the entry — because each query has
 * exactly one consumer. This bounds peak memory in steady state to roughly
 * one entry per active analytics query, not `maxEntries × maxBytes`.
 *
 * Single-process only. A multi-server deployment would need a shared store
 * (e.g. Redis) — see PR description for the limitation.
 */
interface InlineArrowStashOptions {
  /** Maximum number of pending entries (LRU eviction beyond this). Default 100. */
  maxEntries?: number;
  /** Time in ms before an unread entry is auto-evicted. Default 60_000 (60s). */
  ttlMs?: number;
}

interface StashEntry {
  buffer: Buffer;
  expiresAt: number;
}

export class InlineArrowStash {
  private readonly entries = new Map<string, StashEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: InlineArrowStashOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  /** Stash an Arrow IPC buffer and return the synthetic statement_id. */
  put(buffer: Buffer): string {
    this._evictExpired();
    while (this.entries.size >= this.maxEntries) {
      // LRU: oldest insertion order — Map iterates in insertion order.
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    const id = `inline-${randomUUID()}`;
    this.entries.set(id, {
      buffer,
      expiresAt: Date.now() + this.ttlMs,
    });
    return id;
  }

  /**
   * Retrieve and remove a stashed buffer. Returns `null` if the id is not in
   * the stash, expired, or not prefixed `inline-` (in which case the caller
   * should treat it as a real warehouse statement_id).
   */
  take(id: string): Buffer | null {
    if (!id.startsWith("inline-")) return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    if (entry.expiresAt < Date.now()) return null;
    return entry.buffer;
  }

  /** Drop expired entries without consuming them. */
  private _evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(id);
      }
    }
  }

  /** For tests/observability. */
  size(): number {
    return this.entries.size;
  }

  /** For tests. */
  clear(): void {
    this.entries.clear();
  }
}
