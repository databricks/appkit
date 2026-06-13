export const streamDefaults = {
  bufferSize: 100,
  // 1 MiB. SSE is used only for short JSON control messages — JSON_ARRAY
  // result rows (already row-size-bounded by the warehouse) and the small
  // `arrow` envelope (statement id + status) for ARROW_STREAM. Bulk Arrow
  // payloads do not traverse SSE; they are fetched over HTTP via
  // `/api/analytics/arrow-result/:jobId`, which dispatches to the warehouse
  // (EXTERNAL_LINKS) or the server-side `InlineArrowStash` (INLINE) based
  // on the id prefix.
  maxEventSize: 1 * 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
  disconnectGraceMs: 15_000, // 15 seconds
} as const;
