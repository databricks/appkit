{{if .plugins.jobs -}}
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@databricks/appkit-ui/react';
import { useId, useRef, useState } from 'react';

const MAX_STREAM_LOG = 500;

interface Run {
  runId: number;
  state?: { lifeCycleState?: string; resultState?: string };
  startTime?: number;
  endTime?: number;
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

// Request and stream helpers live outside the component: the React Compiler skips components
// that use `finally`, or `throw`, `?:`, `??` or `||` directly inside `try`.
async function requestJob(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function listRuns(jobKey: string): Promise<Run[]> {
  const res = await requestJob(`/api/jobs/${jobKey}/runs?limit=10`);
  const data = (await res.json()) as { runs?: Run[] };
  return data.runs ?? [];
}

/** Calls `onData` with the payloads of each chunk's `data: ` lines until the stream ends. */
async function readStreamData(res: Response, onData: (payloads: string[]) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const payloads = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
    if (payloads.length > 0) onData(payloads);
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

  const fetchStatus = async () => {
    setLoading('status');
    setError(null);
    try {
      const res = await requestJob(`/api/jobs/${jobKey}/status`);
      setStatus(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading('');
  };

  const fetchRuns = async () => {
    setLoading('runs');
    setError(null);
    try {
      setRuns(await listRuns(jobKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading('');
  };

  const triggerRun = async () => {
    setLoading('run');
    setError(null);
    setStreamLog([]);
    streamIdRef.current = 0;
    try {
      const res = await requestJob(`/api/jobs/${jobKey}/run?stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await readStreamData(res, (payloads) => {
        const newEntries = payloads.map((text) => ({ id: ++streamIdRef.current, text }));
        setStreamLog((prev) => {
          const next = [...prev, ...newEntries];
          return next.length > MAX_STREAM_LOG
            ? next.slice(next.length - MAX_STREAM_LOG)
            : next;
        });
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading('');
  };

  const cancelRun = async (runId: number) => {
    setError(null);
    try {
      await requestJob(`/api/jobs/${jobKey}/runs/${runId}`, { method: 'DELETE' });
      await fetchRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6 w-full max-w-4xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Lakeflow Jobs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Trigger, monitor, and manage Databricks Lakeflow Jobs.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-full sm:w-48"
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
                Run #{status.run.runId} &mdash; started{' '}
                {formatTime(status.run.startTime)}
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
                    <tr key={run.runId} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">{run.runId}</td>
                      <td
                        className={`py-2 pr-4 ${stateColor(run.state?.lifeCycleState)}`}
                      >
                        {run.state?.lifeCycleState ?? '\u2014'}
                      </td>
                      <td
                        className={`py-2 pr-4 ${stateColor(run.state?.resultState)}`}
                      >
                        {run.state?.resultState ?? '\u2014'}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatTime(run.startTime)}
                      </td>
                      <td className="py-2">
                        {run.state?.lifeCycleState === 'RUNNING' && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => cancelRun(run.runId)}
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
