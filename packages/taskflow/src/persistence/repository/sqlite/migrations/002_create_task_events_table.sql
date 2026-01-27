CREATE TABLE IF NOT EXISTS task_events (
    entry_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload TEXT,

    FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

-- unique constraint on task_id + seq
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_unique_seq 
ON task_events(task_id, seq);

-- index for streaming events in order
CREATE INDEX IF NOT EXISTS idx_task_events_streaming 
ON task_events(task_id, seq, created_at);
