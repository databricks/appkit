/**
 * Tracks active SSE streams and a per-user stream count. The count is kept in
 * sync with the stream map on every {@link track}/{@link untrack} so the
 * concurrency-limit check is O(1) instead of O(n) over all active streams on
 * every request. `track` and `untrack` are the only writers, which is what
 * keeps the counter from drifting from the map.
 */
export class StreamRegistry {
  private readonly activeStreams = new Map<
    string,
    { controller: AbortController; userId: string }
  >();
  private readonly userStreamCounts = new Map<string, number>();

  /** Count active streams owned by a given user. O(1). */
  count(userId: string): number {
    return this.userStreamCounts.get(userId) ?? 0;
  }

  /** Total active streams across all users. */
  get size(): number {
    return this.activeStreams.size;
  }

  /** Look up an active stream by request id. */
  get(
    requestId: string,
  ): { controller: AbortController; userId: string } | undefined {
    return this.activeStreams.get(requestId);
  }

  /** Register a stream for `userId` and bump the per-user counter. */
  track(requestId: string, userId: string, controller: AbortController): void {
    this.activeStreams.set(requestId, { controller, userId });
    this.userStreamCounts.set(
      userId,
      (this.userStreamCounts.get(userId) ?? 0) + 1,
    );
  }

  /**
   * Remove a stream and decrement the per-user counter. Idempotent — calling
   * twice for the same `requestId` is a no-op. Drops the counter key entirely
   * when it reaches zero so the map can't grow unbounded across many users.
   */
  untrack(requestId: string): void {
    const entry = this.activeStreams.get(requestId);
    if (!entry) return;
    this.activeStreams.delete(requestId);
    const next = (this.userStreamCounts.get(entry.userId) ?? 0) - 1;
    if (next <= 0) {
      this.userStreamCounts.delete(entry.userId);
    } else {
      this.userStreamCounts.set(entry.userId, next);
    }
  }
}
