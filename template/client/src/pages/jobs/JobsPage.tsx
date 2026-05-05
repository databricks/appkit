{{if .plugins.jobs -}}
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';
import { useCallback, useId, useRef, useState } from 'react';

const MAX_STREAM_LOG = 500;

interface Run {
  run_id: number;
  state?: { life_cycle_state?: string; result_state?: string };
  start_time?: number;
  end_time?: number;
}

function formatTime(ts?: number) {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleString();
}

function stateColor(state?: string) {
  switch (state) {
    case 'SUCCESS':
      return 'text-green-600';
    case 'RUNNING':
    case 'PENDING':
      return 'text-yellow-600';
    case 'FAILED':
    case 'TIMEDOUT':
    case 'SKIPPED':
    case 'INTERNAL_ERROR':
      return 'text-red-600';
    default:
      return 'text-muted-foreground';
  }
}

export function JobsPage() {
  const inputId = useId();
  const [jobKey, setJobKey] = useState('default');
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState<{
    status: string | null;
    run: Run | null;
  } | null>(null);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState<string | null>(null);
  const streamIdRef = useRef(0);
  const [streamLog, setStreamLog] = useState<{ id: number; text: string }[]>(
    [],
  );

  const fetchStatus = useCallback(async () => {
    setLoading('status');
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobKey}/status`);
      if (!res.ok) throw new Error(await res.text());
      setStatus(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }, [jobKey]);

  const fetchRuns = useCallback(async () => {
    setLoading('runs');
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobKey}/runs?limit=10`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRuns(data.runs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }, [jobKey]);

  const triggerRun = useCallback(async () => {
    setLoading('run');
    setError(null);
    setStreamLog([]);
    streamIdRef.current = 0;
    try {
      const res = await fetch(`/api/jobs/${jobKey}/run?stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(await res.text());

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        const newEntries: Array<{ id: number; text: string }> = [];
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const id = ++streamIdRef.current;
            newEntries.push({ id, text: line.slice(6) });
          }
        }
        if (newEntries.length > 0) {
          setStreamLog((prev) => {
            const next = [...prev, ...newEntries];
            return next.length > MAX_STREAM_LOG
              ? next.slice(next.length - MAX_STREAM_LOG)
              : next;
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  }, [jobKey]);

  const cancelRun = useCallback(
    async (runId: number) => {
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${jobKey}/runs/${runId}`, {
          method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) throw new Error(await res.text());
        await fetchRuns();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [jobKey, fetchRuns],
  );

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Lakeflow Jobs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Trigger, monitor, and manage Databricks Lakeflow Jobs.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-foreground"
        >
          Job key:
        </label>
        <input
          id={inputId}
          type="text"
          value={jobKey}
          onChange={(e) => setJobKey(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-48"
        />
        <Button
          onClick={fetchStatus}
          variant="outline"
          disabled={!!loading}
        >
          {loading === 'status' ? 'Loading...' : 'Get Status'}
        </Button>
        <Button onClick={fetchRuns} variant="outline" disabled={!!loading}>
          {loading === 'runs' ? 'Loading...' : 'List Runs'}
        </Button>
        <Button onClick={triggerRun} disabled={!!loading}>
          {loading === 'run' ? 'Running...' : 'Trigger Run'}
        </Button>
      </div>

      {error && (
        <div className="text-destructive text-sm p-3 bg-destructive/10 rounded-md">
          {error}
        </div>
      )}

      {status && (
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle>Last Run Status</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              <span className="text-muted-foreground">State: </span>
              <span
                className={`font-medium ${stateColor(status.status ?? undefined)}`}
              >
                {status.status ?? 'No runs'}
              </span>
            </p>
            {status.run && (
              <p className="text-sm text-muted-foreground mt-1">
                Run #{status.run.run_id} &mdash; started{' '}
                {formatTime(status.run.start_time)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {runs.length > 0 && (
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle>Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4">Run ID</th>
                    <th className="pb-2 pr-4">Lifecycle</th>
                    <th className="pb-2 pr-4">Result</th>
                    <th className="pb-2 pr-4">Started</th>
                    <th className="pb-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.run_id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">{run.run_id}</td>
                      <td
                        className={`py-2 pr-4 ${stateColor(run.state?.life_cycle_state)}`}
                      >
                        {run.state?.life_cycle_state ?? '\u2014'}
                      </td>
                      <td
                        className={`py-2 pr-4 ${stateColor(run.state?.result_state)}`}
                      >
                        {run.state?.result_state ?? '\u2014'}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatTime(run.start_time)}
                      </td>
                      <td className="py-2">
                        {run.state?.life_cycle_state === 'RUNNING' && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => cancelRun(run.run_id)}
                          >
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {streamLog.length > 0 && (
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle>Run Stream</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted rounded-md p-3 max-h-80 overflow-y-auto font-mono text-xs space-y-1">
              {streamLog.map((entry) => (
                <div key={entry.id}>{entry.text}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
{{- end}}
