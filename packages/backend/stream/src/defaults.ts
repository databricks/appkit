export const streamDefaults = {
  bufferSize: 100,
  maxEventSize: 1024 * 1024, // 1MB
  bufferTTL: 10 * 60 * 1000, // 10 minutes
  cleanupInterval: 5 * 60 * 1000, // 5 minutes
  maxPersistentBuffers: 10000, // 10000 buffers
  heartbeatInterval: 10 * 1000, // 10 seconds
} as const;
