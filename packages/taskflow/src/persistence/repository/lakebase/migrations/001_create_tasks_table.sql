CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'running', 'completed', 'failed', 'cancelled')),
  type TEXT NOT NULL CHECK (type IN ('background', 'user')),
  input_data TEXT,
  idempotency_key TEXT NOT NULL,
  user_id TEXT,
  created_at TIMESTAMP NOT NULL,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  duration_ms INTEGER,
  result_truncated INTEGER DEFAULT 0,
  last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  result TEXT,
  error TEXT,
  attempt INTEGER DEFAULT 0,
  execution_options TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency_active
ON tasks(idempotency_key)
WHERE status IN ('created', 'pending', 'running');

CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);

CREATE INDEX IF NOT EXISTS idx_tasks_alive_check
ON tasks(idempotency_key, last_heartbeat_at, status)
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_tasks_stale
ON tasks(status, last_heartbeat_at)
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_tasks_pending_recovery
ON tasks(status, created_at)
WHERE status IN ('created', 'pending');
