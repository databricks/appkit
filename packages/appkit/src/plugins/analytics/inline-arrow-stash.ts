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
 * - **Memory bounded with rejection**: total stashed bytes are capped.
 *   When `put()` cannot fit a payload without exceeding the cap it
 *   returns `null` rather than evicting older entries — every issued id
 *   stays valid until it is drained, expires, or the process exits.
 *   Callers are expected to fall back to a different delivery path (e.g.
 *   EXTERNAL_LINKS) when `put()` rejects.
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
  /** Soft cap on total bytes held. Oldest entries are evicted to fit. */
  maxBytes?: number;
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
}

export class InlineArrowStash {
  private entries = new Map<string, StashEntry>();
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly idGenerator: () => string;
  private readonly now: () => number;

  constructor(opts: InlineArrowStashOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.idGenerator = opts.idGenerator ?? randomUUID;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Stash a payload and return its synthetic job id, or `null` when the
   * stash cannot accept it without evicting older entries. The caller is
   * expected to fall back to an out-of-band delivery path (e.g.
   * EXTERNAL_LINKS) when the return value is `null`.
   *
   * Single payloads that exceed `maxBytes` outright throw so the caller
   * sees the misconfiguration loudly instead of degrading silently every
   * time.
   */
  put(userId: string, bytes: Uint8Array): string | null {
    if (bytes.length > this.maxBytes) {
      throw new Error(
        `Inline Arrow payload (${bytes.length} bytes) exceeds stash maxBytes (${this.maxBytes})`,
      );
    }
    this.gc();
    if (this.totalBytes + bytes.length > this.maxBytes) {
      // Refuse rather than evicting: every id we have already issued must
      // remain valid until naturally drained or expired.
      return null;
    }
    const id = `inline-${this.idGenerator()}`;
    const now = this.now();
    this.entries.set(id, {
      userId,
      bytes,
      expiresAt: now + this.ttlMs,
      insertedAt: now,
    });
    this.totalBytes += bytes.length;
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
    this.totalBytes -= entry.bytes.length;
    return entry.bytes;
  }

  /** Inspection helpers (primarily for tests). */
  size(): number {
    return this.totalBytes;
  }
  count(): number {
    return this.entries.size;
  }

  /** Drop all entries (used in plugin shutdown). */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private gc(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        this.totalBytes -= entry.bytes.length;
      }
    }
  }
}
