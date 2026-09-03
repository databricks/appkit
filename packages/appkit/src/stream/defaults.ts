export const streamDefaults = {
  bufferSize: 100,
  // Bounds the JSON_ARRAY path only: ARROW_STREAM bytes stream back on the
  // query response body (`_handleArrowStreamQuery`), never over SSE.
  // Keep in sync with `connectSSE`'s `maxBufferSize` default.
  maxEventSize: 5 * 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
  disconnectGraceMs: 15_000, // 15 seconds
} as const;
