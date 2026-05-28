# app-with-task

Minimal AppKit app demonstrating the **TaskFlow private-preview CUJ**:
durable analytics queries that survive a server crash.

The app exposes two long-running TPC-H queries through the analytics
plugin. Each query runs as a TaskFlow durable task, so the engine writes
a WAL entry checkpointing the warehouse `statement_id` before polling.
If the Node process is killed while a query is still executing on the
warehouse, the **next request with the same query/params re-attaches**:
the engine matches the deterministic idempotency key, on-demand recovers
the task inline, replays the checkpoint, polls the same `statement_id`,
and returns the same result — without re-submitting the statement.

## Stack

- `server.ts` — `createApp({ plugins: [server(), analytics({})] })` with
  TaskFlow timings tightened for a snappy demo.
- `config/queries/` — two SQL files: a single-table aggregate and a
  3-way join over `samples.tpch.*`.
- `src/App.tsx` — React UI with two panels using
  `useAnalyticsQuery(...)`. Each panel shows status (`idle` / `task
  active` / `complete` / `failed`) and a running timer.

## Setup

```bash
cp .env.dist .env
# Fill DATABRICKS_HOST, DATABRICKS_WAREHOUSE_ID, DATABRICKS_TOKEN.

pnpm install
pnpm --filter=app-with-task dev
```

The server prints `http://localhost:8000` once boot finishes. Open it,
click **Run query**, watch the timer climb.

## The CUJ — headless script (recommended first)

```bash
# Terminal 1
pnpm --filter=app-with-task dev

# Terminal 2 — runs CUJ, kills the server mid-query, asks you to restart
pnpm --filter=app-with-task cuj:crash --query slow_aggregate --kill-after-ms 2000
# When you see "phase 2: server is dead", run `pnpm --filter=app-with-task dev`
# again in terminal 1. The script polls /health and resumes automatically.
```

The script reports a green `✅ TaskFlow recovered the durable task across crash.`
when phase 2 reuses the same idempotency key and reaches a terminal event.

## The CUJ — manual browser walkthrough

1. **Start the server**: `pnpm --filter=app-with-task dev`.
2. **Open the browser** at `http://localhost:8000`.
3. **Click "Run query"** on the TPC-H Q1 panel. The status flips to
   `task active` and the timer starts.
4. **In another terminal, kill the server hard**:
   ```bash
   pkill -9 -f "tsx watch server.ts"   # or `lsof -i :8000` then `kill -9 <pid>`
   ```
5. Confirm the durable state is on disk:
   ```bash
   sqlite3 .appkit/tasks/tasks.db \
     "SELECT idempotency_key, status FROM tasks ORDER BY rowid DESC LIMIT 5"
   # one row with status='Running' (or 'Suspended' if the recovery worker ran).
   ```
6. **Restart the server**: `pnpm --filter=app-with-task dev`.
7. **In the browser, click "Run query" again on the same panel.** The
   client POSTs the same query + params → same idempotency key → engine
   finds the existing task → recovers inline → polls the original
   `statement_id` → emits the data frame. The UI shows `complete`
   without a fresh warehouse submission.

What you should see in the server log on step 7:
```
Submit dedup: stale Running -> on-demand recovery   (engine engine.rs:1306)
analytics task recovery: reattach statement_id=...  (analytics.ts:172)
```

## Why this works

- **Deterministic IK**: `executeTask` derives the idempotency key from
  `(taskName, input)`. Same query + same params + same executor key →
  same key across restarts.
- **WAL durability**: `statement_submitted` checkpoint hits the WAL
  before the warehouse poll loop starts.
- **Admission dedup**: on the second `start()`, `admission/dedup.rs`
  returns `ExistingTask` instead of `NewTask`. The engine then either
  auto-resumes a `Suspended` task or on-demand recovers a stale
  `Running` one — both call back into the analytics handler with
  `ctx.isRecovery = true` and the prior `previousEvents`.
- **Smart recovery in analytics**: `_runQueryInner` checks
  `ctx.previousEvents` for `statement_submitted` and skips straight to
  `pollStatement(statement_id)` — the warehouse statement is still
  running, so we just collect its result.

## Storage backends

| Env                       | Backend  | Persistence                          |
| ------------------------- | -------- | ------------------------------------ |
| _(default)_               | SQLite   | `.appkit/tasks/tasks.db` on disk     |
| `LAKEBASE_TASK_DB_URL=…`  | Lakebase | Postgres (durable across pod cycles) |

SQLite works locally because the file survives `kill -9`. On Databricks
Apps the file is per-pod and ephemeral; for a production demo (or a
deploy of this app), set `LAKEBASE_TASK_DB_URL` to a Lakebase Postgres
connection string before booting.

## Caveats

- The warehouse query must be slow enough to outlive the kill→restart
  cycle (~10–20s). If the warehouse caches the result the second run
  will succeed too quickly to be visually convincing — change one
  parameter or pick the heavier `heavy_join` query.
- The analytics task is registered with `autoRecover: false`. That is
  intentional: it forces recovery to ride on a fresh client request
  carrying its `UserContext` (matters for OBO queries). The background
  recovery worker only marks stale tasks `Suspended`; the real revival
  happens on the next `executeTask` call from the client.
