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
 * - **Optional backpressure** (`putBlocking()`): rather than rejecting
 *   immediately when full, wait FIFO for up to `putWaitMs` for an existing
 *   entry to drain before retrying. The stash is drain-on-read with a
 *   short TTL, so on warehouses where `INLINE + ARROW_STREAM` is the
 *   accepted path (e.g. Reyden, which refuses `EXTERNAL_LINKS`), a brief
 *   wait almost always frees a slot from the in-flight `/arrow-result`
 *   GET that any concurrent query is about to issue. Callers can keep the
 *   EXTERNAL_LINKS fallback for true sustained overload.
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
   * Hard cap on total bytes held. `put()` rejects (returns `null`) once
   * the cap would be exceeded; entries already in the stash are not
   * evicted to fit new ones.
   */
  maxBytes?: number;
  /**
   * Max time `putBlocking()` waits for an existing entry to drain when
   * the stash is full. Defaults to 0 — i.e. `putBlocking()` behaves like
   * the synchronous `put()`. Synchronous `put()` itself never waits.
   */
  putWaitMs?: number;
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

interface Waiter {
  needed: number;
  wake: () => void;
}

export class InlineArrowStash {
  private entries = new Map<string, StashEntry>();
  private totalBytes = 0;
  private waiters: Waiter[] = [];
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly putWaitMs: number;
  private readonly idGenerator: () => string;
  private readonly now: () => number;

  constructor(opts: InlineArrowStashOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.putWaitMs = opts.putWaitMs ?? 0;
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
   * Like `put()` but, when the stash is full, waits up to `putWaitMs`
   * for an existing entry to drain (via `take()` or TTL eviction) before
   * giving up. Returns the synthetic id on success, or `null` when the
   * wait elapses without a slot freeing — at which point the caller
   * should fall back to its out-of-band delivery path.
   *
   * Wakes happen FIFO: the head waiter is satisfied first. If `signal`
   * aborts before a slot frees, the wait resolves with `null` and the
   * waiter drops out of the queue without consuming the next free slot.
   */
  async putBlocking(
    userId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const immediate = this.put(userId, bytes);
    if (immediate !== null) return immediate;
    if (this.putWaitMs <= 0 || signal?.aborted) return null;

    return new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wake = () => {
        if (settled) return;
        // wakeWaiters() has confirmed totalBytes + needed <= maxBytes;
        // put() should succeed. The retry guards against an unlikely
        // concurrent gc()/take() shuffle.
        const id = this.put(userId, bytes);
        settle(id);
      };
      const onAbort = () => settle(null);
      const waiter: Waiter = { needed: bytes.length, wake };
      this.waiters.push(waiter);
      const timer = setTimeout(() => settle(null), this.putWaitMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
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
    this.wakeWaiters();
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
    this.wakeWaiters();
  }

  private gc(): void {
    const now = this.now();
    let freed = false;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        this.totalBytes -= entry.bytes.length;
        freed = true;
      }
    }
    if (freed) this.wakeWaiters();
  }

  /**
   * FIFO drain of the wait queue. Walks from head until either the queue
   * is empty or the head waiter does not fit. The head is shifted off
   * BEFORE wake() runs so that any re-entry from gc()/put() inside the
   * waiter's put attempt cannot pick up the same waiter again.
   */
  private wakeWaiters(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0];
      if (this.totalBytes + head.needed > this.maxBytes) return;
      this.waiters.shift();
      head.wake();
    }
  }
}
