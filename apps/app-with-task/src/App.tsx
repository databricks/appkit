import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

type QueryKey = "slow_aggregate" | "heavy_join";

interface LogLine {
  ts: number;
  msg: string;
}

function useElapsedSeconds(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startedAtRef.current != null) {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [running]);

  return elapsed;
}

/**
 * Inner runner: lives behind a React `key` that the parent bumps on
 * every click. Each remount fires exactly one `useAnalyticsQuery`. The
 * query is parameter-less so the deterministic idempotency key stays
 * stable across restarts — that's the whole point of the demo.
 */
function QueryRunner({
  queryKey,
  onLog,
}: {
  queryKey: QueryKey;
  onLog: (line: string) => void;
}) {
  const { data, loading, error } = useAnalyticsQuery(queryKey, null);
  const elapsed = useElapsedSeconds(loading);

  // Hold `onLog` in a ref so the effects can fire only on the events we
  // care about (loading-rising-edge / error / data) without re-running
  // every time the parent rerenders and hands us a fresh callback.
  const logRef = useRef(onLog);
  useEffect(() => {
    logRef.current = onLog;
  }, [onLog]);

  useEffect(() => {
    if (loading) logRef.current(`[${queryKey}] loading…`);
  }, [loading, queryKey]);

  useEffect(() => {
    if (error) logRef.current(`[${queryKey}] error: ${error}`);
  }, [error, queryKey]);

  useEffect(() => {
    if (data)
      logRef.current(`[${queryKey}] data received (${rowCount(data)} rows)`);
  }, [data, queryKey]);

  return (
    <>
      <div className="controls">
        <span className="status">
          {loading
            ? `task active · ${elapsed.toFixed(1)}s`
            : error
              ? "failed"
              : data
                ? "complete"
                : "idle"}
        </span>
      </div>
      {error ? <pre className="error">{error}</pre> : null}
      {data ? (
        <details>
          <summary>{rowCount(data)} rows</summary>
          <pre className="result">{JSON.stringify(data, null, 2)}</pre>
        </details>
      ) : null}
    </>
  );
}

function QueryPanel({
  queryKey,
  title,
  description,
  badge,
  disabled = false,
  onLog,
}: {
  queryKey: QueryKey;
  title: string;
  description: string;
  badge: "Preview" | "Later";
  disabled?: boolean;
  onLog: (line: string) => void;
}) {
  const [run, setRun] = useState(0);

  return (
    <section className="panel">
      <header>
        <h2>
          {title}
          <span className={`badge badge-${badge.toLowerCase()}`}>{badge}</span>
        </h2>
        <p className="muted">{description}</p>
      </header>
      <div className="controls">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setRun((n) => n + 1)}
        >
          {run === 0 ? "Run query" : "Run again"}
        </button>
      </div>
      {run > 0 && !disabled ? (
        <QueryRunner key={run} queryKey={queryKey} onLog={onLog} />
      ) : null}
    </section>
  );
}

function rowCount(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const rows = (data as { rows?: unknown[] }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}

export default function App() {
  const [logs, setLogs] = useState<LogLine[]>([]);

  const appendLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, { ts: Date.now(), msg }].slice(-50));
  }, []);

  return (
    <>
      <output className="notice">
        <span className="notice-dot" aria-hidden="true" />
        <span className="notice-copy">
          <strong>SQL Warehouse is warming up</strong> — a freshly deployed
          warehouse takes a moment to start. Empty results at first are the
          warehouse spinning up, not an app error.
        </span>
        <a
          className="notice-link"
          href="/sql/warehouses"
          target="_blank"
          rel="noreferrer"
        >
          View warehouse →
        </a>
      </output>

      <main className="app">
        <header className="hero">
          <h1>AppKit × TaskFlow</h1>
          <p>
            Durable analytics queries. Run a query, kill the server with
            <code>kill -9</code>, restart, re-run the same query — the engine
            deduplicates by idempotency key, recovers the task, polls the
            original warehouse <code>statement_id</code>, and returns the same
            result.
          </p>
        </header>

        <div className="grid">
          <QueryPanel
            queryKey="slow_aggregate"
            title="Synthetic aggregate"
            badge="Preview"
            description="CPU-heavy hash aggregate over 300M synthetic rows, tuned for small warehouses."
            onLog={appendLog}
          />
          <QueryPanel
            queryKey="heavy_join"
            title="3-way TPC-H join"
            badge="Later"
            description="Stress query for larger warehouses; not part of the private-preview golden path."
            disabled
            onLog={appendLog}
          />
        </div>

        <section className="logs">
          <h3>Client log</h3>
          {logs.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ul>
              {logs.map((line) => (
                <li key={`${line.ts}-${line.msg}`}>
                  <span className="muted">
                    {new Date(line.ts).toLocaleTimeString()}{" "}
                  </span>
                  {line.msg}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
