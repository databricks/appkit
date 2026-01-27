CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'running', 'completed', 'failed', 'cancelled')),
  type TEXT NOT NULL CHECK (type IN ('background', 'user')),
  input_data TEXT,
  idempotency_key TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  result_truncated INTEGER DEFAULT 0,
  last_heartbeat_at TEXT DEFAULT CURRENT_TIMESTAMP,
  result TEXT,
  error TEXT,
  attempt INTEGER DEFAULT 0,
  execution_options TEXT
);

-- unique constraint on idempotency key for active tasks only
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency_active
ON tasks(idempotency_key)
WHERE status IN ('created', 'pending', 'running');

-- index for type filtering
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);

-- index for checking if a task is alive
CREATE INDEX IF NOT EXISTS idx_tasks_alive_check
ON tasks(idempotency_key, last_heartbeat_at, status)
WHERE status = 'running';

-- index for finding stale tasks
CREATE INDEX IF NOT EXISTS idx_tasks_stale
ON tasks(status, last_heartbeat_at)
WHERE status = 'running';

-- index for pending task recovery
CREATE INDEX IF NOT EXISTS idx_tasks_pending_recovery
ON tasks(status, created_at)
WHERE status IN ('created', 'pending');
