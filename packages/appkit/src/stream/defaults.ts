export const streamDefaults = {
  bufferSize: 100,
  // 1 MiB. SSE carries control messages (statement_id, status, errors) and
  // small JSON_ARRAY result payloads. Bulk Arrow data is delivered out of
  // band via the /arrow-result/:jobId endpoint, backed by InlineArrowStash
  // for INLINE responses. This keeps SSE memory pressure bounded.
  maxEventSize: 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
} as const;
