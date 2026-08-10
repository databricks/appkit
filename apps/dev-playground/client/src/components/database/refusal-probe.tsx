import { Badge, Button } from "@databricks/appkit-ui/react";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

/**
 * Fires one request the plugin is expected to refuse and prints what came
 * back. The guarantees on this page are only worth as much as the response,
 * so the page asks the running server instead of asserting.
 */

interface Attempt {
  status: number;
  body: string;
}

export function RefusalProbe({
  label,
  request,
  send,
}: {
  /** What the caller is trying to get away with. */
  label: string;
  /** The request as a reader would write it, shown before running. */
  request: string;
  send: () => Promise<Response>;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const response = await send();
      const text = await response.text();
      setAttempt({ status: response.status, body: text.slice(0, 400) });
    } catch (error) {
      setAttempt({ status: 0, body: String(error) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <code className="text-xs text-muted-foreground break-all">
            {request}
          </code>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={running}>
          <PlayIcon className="h-3 w-3" />
          Try it
        </Button>
      </div>
      {attempt && (
        <div className="flex items-start gap-2">
          <Badge
            variant={attempt.status >= 400 ? "destructive" : "secondary"}
            className="tabular-nums shrink-0"
          >
            {attempt.status}
          </Badge>
          <code className="text-xs break-all">{attempt.body}</code>
        </div>
      )}
    </div>
  );
}
