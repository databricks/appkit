export const streamDefaults = {
  bufferSize: 100,
  // 12 MiB. Headroom for base64-encoded inline Arrow IPC attachments: the
  // connector caps the *decoded* attachment at 8 MiB (MAX_INLINE_ATTACHMENT_BYTES),
  // which inflates to ~10.6 MiB once base64-encoded and is then wrapped in JSON +
  // SSE framing. 12 MiB leaves enough room for that overhead so legal 8-MiB-decoded
  // attachments do not trip the stream-manager cap before the connector-level cap.
  maxEventSize: 12 * 1024 * 1024,
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
  maxActiveStreams: 1000, // 1000 streams
} as const;
