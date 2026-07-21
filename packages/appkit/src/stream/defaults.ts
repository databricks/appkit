export const streamDefaults = {
  bufferSize: 100,
  // 1 MiB. SSE carries only short JSON control messages — JSON_ARRAY result
  // rows (already row-size-bounded by the warehouse) plus warehouse-readiness
  // and error events. ARROW_STREAM never uses SSE: the raw Arrow IPC bytes
  // stream back on the query response body (`_handleArrowStreamQuery`).
  maxEventSize: 1 * 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
  disconnectGraceMs: 15_000, // 15 seconds
} as const;
