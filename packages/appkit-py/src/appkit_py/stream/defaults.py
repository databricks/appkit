"""Stream default configuration values matching the TypeScript implementation."""

STREAM_DEFAULTS = {
    "buffer_size": 100,
    "max_event_size": 1024 * 1024,  # 1MB
    "buffer_ttl": 10 * 60,  # 10 minutes (seconds)
    "cleanup_interval": 5 * 60,  # 5 minutes (seconds)
    "max_persistent_buffers": 10000,
    "heartbeat_interval": 10,  # 10 seconds
    "max_active_streams": 1000,
}
