export const streamDefaults = {
  bufferSize: 100,
  // 8 MiB. Sized to fit base64-encoded inline Arrow IPC attachments from
  // serverless warehouses (analytics queries typically return well under 1 MiB,
  // but ARROW_STREAM + INLINE can carry up to ~25 MiB per the Databricks API).
  // The connector enforces the same cap (`MAX_INLINE_ATTACHMENT_BYTES`) so
  // anything that would exceed this fails fast at the connector with a clear
  // error rather than a confusing SSE buffer-exceeded.
  maxEventSize: 8 * 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
} as const;
