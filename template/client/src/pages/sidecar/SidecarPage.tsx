{{- if .plugins.sidecar -}}
import { useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
} from '@databricks/appkit-ui/react';

interface SidecarResponse {
  message: string;
  user: string;
}

export function SidecarPage() {
  const [data, setData] = useState<SidecarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function callSidecar() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/sidecar/hello');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 mt-8">
      <h2 className="text-2xl font-bold text-foreground">Sidecar</h2>
      <p className="text-muted-foreground">
        This page calls the Python sidecar process managed by AppKit.
        Requests to <code className="text-sm bg-muted px-1 rounded">/api/sidecar/*</code> are
        proxied to the child process.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Call Sidecar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={callSidecar} disabled={loading}>
            {loading ? 'Calling…' : 'GET /api/sidecar/hello'}
          </Button>

          {loading && <Skeleton className="h-16 w-full" />}

          {error && (
            <p className="text-sm text-destructive">Error: {error}</p>
          )}

          {data && !loading && (
            <pre className="bg-muted p-4 rounded text-sm overflow-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
{{- end}}
