import { randomUUID } from "node:crypto";

/**
 * Server-side stash for inline Arrow IPC payloads.
 *
 * When a warehouse returns ARROW_STREAM + INLINE results, the bytes are
 * stashed here and a synthetic "inline-<uuid>" job id is emitted on the
 * SSE control channel. The client then fetches the bytes out-of-band via
 * `/arrow-result/<id>`, which drains the stash and serves the payload as
 * `application/vnd.apache.arrow.stream`.
 *
 * Keeps multi-MiB Arrow blobs off SSE, lets the existing /arrow-result
 * pipeline handle both inline and EXTERNAL_LINKS results uniformly, and
 * delivers the bytes with a real binary content-type instead of base64
 * inside JSON inside SSE framing.
 *
 * Properties:
 * - **Drain-on-read**: a successful `take()` removes the entry. There is
 *   no replay path — a lost client connection means the bytes are gone.
 * - **TTL bounded**: entries past their expiry are evicted on every
 *   `put()` and `take()`. No background timer.
 * - **Per-user keyed**: `take()` only returns bytes if the requesting
 *   user matches the user that originally put them. Defense in depth on
 *   top of unguessable ids.
 * - **Memory bounded with overflow slot**: total stashed bytes are capped
 *   at `maxBytes`. When `put()` cannot fit a payload, it spills into a
 *   separate overflow pool capped at `maxOverflowBytes` (default same as
 *   `maxBytes`). Overflow entries behave identically to regular ones
 *   except they do not count against the regular cap — they are bytes
 *   the caller has *already paid to decode for this single request*, so
 *   throwing them away would force a second warehouse round-trip. Only
 *   when both pools are full does `put()` return `null` and the caller
 *   has to fall back to a different delivery path. Memory is bounded
 *   above by `maxBytes + maxOverflowBytes`.
 *
 * Caveat (multi-replica deployments): this stash is process-local. A
 * subsequent `GET /arrow-result/inline-*` that lands on a different
 * replica than the one that stashed the bytes will 410. Deployments
 * that run more than one replica need sticky sessions (route both
 * requests in the same logical session to the same replica) or a
 * shared external store, neither of which is in scope here.
 */
interface InlineArrowStashOptions {
  /** Entries older than this are dropped on the next gc tick. */
  ttlMs?: number;
  /**
   * Hard cap on total bytes held in the regular pool. `put()` spills to
   * the overflow pool when this cap would be exceeded; entries already
   * in the stash are not evicted to fit new ones.
   */
  maxBytes?: number;
  /**
   * Hard cap on total bytes held in the overflow pool. Overflow holds
   * bytes that have already been decoded for an in-flight request — its
   * purpose is to avoid throwing those bytes away and double-billing
   * the warehouse. Defaults to `maxBytes`. `put()` returns `null` only
   * when both regular and overflow pools are at cap.
   */
  maxOverflowBytes?: number;
  /** Test seam: override the synthetic-id generator. */
  idGenerator?: () => string;
  /** Test seam: override the clock. */
  now?: () => number;
}

interface StashEntry {
  userId: string;
  bytes: Uint8Array;
  expiresAt: number;
  insertedAt: number;
  /** True for entries in the overflow pool (do not count against maxBytes). */
  overflow: boolean;
}

export class InlineArrowStash {
  private entries = new Map<string, StashEntry>();
  private totalBytes = 0;
  private overflowBytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxOverflowBytes: number;
  private readonly idGenerator: () => string;
  private readonly now: () => number;

  constructor(opts: InlineArrowStashOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.maxOverflowBytes = opts.maxOverflowBytes ?? this.maxBytes;
    this.idGenerator = opts.idGenerator ?? randomUUID;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Stash a payload and return its synthetic job id.
   *
   * Tries the regular pool first; if it would overflow, spills into the
   * overflow pool (sized at `maxOverflowBytes`). Returns `null` only when
   * both pools are at cap — the caller then has no choice but to fall
   * back to a different delivery path (e.g. EXTERNAL_LINKS).
   *
   * The overflow pool exists because the caller has *already decoded*
   * these bytes for an in-flight request: throwing them away would force
   * a second warehouse round-trip (extra latency, double billing, and
   * potentially divergent results for non-deterministic SQL). Holding
   * them transiently in a bounded overflow region — they are drained
   * single-use on the next `/arrow-result` fetch — is strictly safer
   * than re-execution.
   *
   * Single payloads that exceed `maxBytes + maxOverflowBytes` outright
   * throw so the caller sees the misconfiguration loudly.
   */
  put(userId: string, bytes: Uint8Array): string | null {
    const totalCap = this.maxBytes + this.maxOverflowBytes;
    if (bytes.length > totalCap) {
      throw new Error(
        `Inline Arrow payload (${bytes.length} bytes) exceeds stash capacity (${totalCap})`,
      );
    }
    this.gc();
    const fitsRegular = this.totalBytes + bytes.length <= this.maxBytes;
    const fitsOverflow =
      !fitsRegular &&
      this.overflowBytes + bytes.length <= this.maxOverflowBytes;
    if (!fitsRegular && !fitsOverflow) {
      // Both pools are full — refuse rather than evicting any issued id.
      return null;
    }
    const id = `inline-${this.idGenerator()}`;
    const now = this.now();
    this.entries.set(id, {
      userId,
      bytes,
      expiresAt: now + this.ttlMs,
      insertedAt: now,
      overflow: !fitsRegular,
    });
    if (fitsRegular) {
      this.totalBytes += bytes.length;
    } else {
      this.overflowBytes += bytes.length;
    }
    return id;
  }

  /**
   * Drain a payload from the stash. Returns `undefined` if the id is
   * unknown, expired, or belongs to a different user.
   */
  take(id: string, userId: string): Uint8Array | undefined {
    this.gc();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.userId !== userId) return undefined;
    this.entries.delete(id);
    if (entry.overflow) {
      this.overflowBytes -= entry.bytes.length;
    } else {
      this.totalBytes -= entry.bytes.length;
    }
    return entry.bytes;
  }

  /** Inspection helpers (primarily for tests). */
  size(): number {
    return this.totalBytes;
  }
  /** Bytes currently held in the overflow pool. */
  overflowSize(): number {
    return this.overflowBytes;
  }
  count(): number {
    return this.entries.size;
  }

  /** Drop all entries (used in plugin shutdown). */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.overflowBytes = 0;
  }

  private gc(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        if (entry.overflow) {
          this.overflowBytes -= entry.bytes.length;
        } else {
          this.totalBytes -= entry.bytes.length;
        }
      }
    }
  }
}
