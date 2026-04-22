import {
  Badge,
  Button,
  usePluginClientConfig,
} from "@databricks/appkit-ui/react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/policy-matrix")({
  component: PolicyMatrixRoute,
});

interface FilesClientConfig {
  volumes?: string[];
}

/**
 * Every action the files plugin exposes over HTTP. Kept in display order
 * (read actions first, then writes) so the matrix reads naturally.
 */
const ACTIONS = [
  "list",
  "read",
  "download",
  "raw",
  "exists",
  "metadata",
  "preview",
  "upload",
  "mkdir",
  "delete",
] as const;

const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "upload",
  "mkdir",
  "delete",
]);

type Action = (typeof ACTIONS)[number];

/**
 * For policy testing purposes, the important distinction is 403-denied
 * vs. anything else. Within "anything else" we break out 404 separately
 * because the matrix probes against a synthetic path that may not exist
 * — 404 means "policy passed, file missing", which is still a pass.
 */
type PolicyVerdict = "allowed" | "allowed-missing" | "denied" | "error";

type ProbeOutcome =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      httpStatus: number;
      verdict: PolicyVerdict;
      message: string;
    };

function classify(httpStatus: number): PolicyVerdict {
  if (httpStatus >= 200 && httpStatus < 300) return "allowed";
  if (httpStatus === 403) return "denied";
  if (httpStatus === 404) return "allowed-missing";
  return "error";
}

type MatrixState = Record<string, Record<Action, ProbeOutcome>>;

/** Per-probe test path. Kept short so cleanup is easy if a write succeeds. */
const PROBE_PATH = "__policy_probe__.txt";
const PROBE_DIR = "__policy_probe_dir__";

interface WhoAmI {
  xForwardedUser: string | null;
  adminUserId: string | null;
  isAdmin: boolean;
}

function PolicyMatrixRoute() {
  const { volumes = [] } = usePluginClientConfig<FilesClientConfig>("files");
  const [state, setState] = useState<MatrixState>({});
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [spResult, setSpResult] = useState<string | null>(null);
  const [oboResult, setOboResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/whoami")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setWhoami(data))
      .catch(() => setWhoami(null));
  }, []);

  const initialState = useMemo<MatrixState>(() => {
    const s: MatrixState = {};
    for (const v of volumes) {
      s[v] = {} as Record<Action, ProbeOutcome>;
      for (const a of ACTIONS) s[v][a] = { status: "idle" };
    }
    return s;
  }, [volumes]);

  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  const setCell = useCallback(
    (volume: string, action: Action, next: ProbeOutcome) => {
      setState((prev) => ({
        ...prev,
        [volume]: { ...prev[volume], [action]: next },
      }));
    },
    [],
  );

  /** Fire the real HTTP route the action maps to and capture status/body. */
  const runProbe = useCallback(
    async (volume: string, action: Action) => {
      setCell(volume, action, { status: "loading" });

      try {
        const response = await probe(volume, action);
        const body = await response
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error?: unknown }).error)
            : response.ok
              ? "ok"
              : response.statusText;
        const verdict = classify(response.status);
        setCell(volume, action, {
          status: "done",
          httpStatus: response.status,
          verdict,
          message,
        });
      } catch (err) {
        setCell(volume, action, {
          status: "done",
          httpStatus: 0,
          verdict: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [setCell],
  );

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      // Seed the probe file on volumes where writes are expected to be
      // allowed, so reads return real content instead of 404. We don't
      // know the policies client-side, so we try a best-effort upload
      // and ignore the result — volumes that deny will just show 404
      // on read actions, which the UI now renders as "allowed*".
      await Promise.all(
        volumes.map((v) =>
          fetch(
            `/api/files/${v}/upload?${new URLSearchParams({
              path: PROBE_PATH,
            }).toString()}`,
            {
              method: "POST",
              body: new Blob(["policy probe seed"], { type: "text/plain" }),
            },
          ).catch(() => {}),
        ),
      );
      await Promise.all(
        volumes.map(async (v) => {
          for (const a of ACTIONS) {
            await runProbe(v, a);
          }
        }),
      );
    } finally {
      setRunningAll(false);
    }
  }, [volumes, runProbe]);

  const runSpSmoke = useCallback(async () => {
    setSpResult("…");
    const r = await fetch("/policy/sp");
    setSpResult(JSON.stringify(await r.json(), null, 2));
  }, []);

  const runOboSmoke = useCallback(async () => {
    setOboResult("…");
    const r = await fetch("/policy/obo");
    setOboResult(JSON.stringify(await r.json(), null, 2));
  }, []);

  const reset = useCallback(() => setState(initialState), [initialState]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <Header
          title="Files Policy Matrix"
          description="Probe every (volume × action) pair to verify SP policy enforcement on the deployed app."
          tooltip="Each cell fires the real HTTP route and shows the status code returned by the server. Expected outcomes are summarized in the legend."
        />

        <WhoAmI whoami={whoami} />

        <div className="mb-6 flex items-center gap-3">
          <Button
            onClick={runAll}
            disabled={runningAll || volumes.length === 0}
          >
            {runningAll ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run all
          </Button>
          <Button variant="outline" onClick={reset} disabled={runningAll}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <Legend />
        </div>

        {volumes.length === 0 ? (
          <p className="text-muted-foreground">
            No volumes configured. Set <code>DATABRICKS_VOLUME_*</code> env vars
            and restart the server.
          </p>
        ) : (
          <div className="overflow-x-auto border rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 sticky left-0 bg-muted/50">
                    Volume
                  </th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="text-left px-2 py-2">
                      <div className="flex flex-col gap-1">
                        <span>{a}</span>
                        <span className="text-[10px] text-muted-foreground uppercase">
                          {WRITE_ACTIONS.has(a) ? "write" : "read"}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {volumes.map((volume) => (
                  <tr key={volume} className="border-t">
                    <td className="px-3 py-2 font-mono sticky left-0 bg-background">
                      {volume}
                    </td>
                    {ACTIONS.map((a) => (
                      <td key={a} className="px-1 py-1">
                        <Cell
                          outcome={state[volume]?.[a] ?? { status: "idle" }}
                          onRun={() => runProbe(volume, a)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-xl font-semibold mb-2">
            Programmatic API smoke tests
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Confirms <code>PolicyDeniedError</code> is thrown from the SDK path
            (not just HTTP 403). These hit the dev-playground's{" "}
            <code>/policy/sp</code> and <code>/policy/obo</code> routes.
          </p>
          <div className="flex gap-3 mb-4">
            <Button variant="outline" onClick={runSpSmoke}>
              Run SP smoke
            </Button>
            <Button variant="outline" onClick={runOboSmoke}>
              Run OBO smoke
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SmokePanel title="Service principal" body={spResult} />
            <SmokePanel title="On-behalf-of user" body={oboResult} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({
  outcome,
  onRun,
}: {
  outcome: ProbeOutcome;
  onRun: () => void;
}) {
  if (outcome.status === "idle") {
    return (
      <Button variant="outline" size="sm" className="w-full" onClick={onRun}>
        Run
      </Button>
    );
  }
  if (outcome.status === "loading") {
    return (
      <Button variant="outline" size="sm" className="w-full" disabled>
        <Loader2 className="h-3 w-3 animate-spin" />
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={onRun}
      className="w-full text-left"
      title={outcome.message}
    >
      <StatusBadge
        httpStatus={outcome.httpStatus}
        verdict={outcome.verdict}
        message={outcome.message}
      />
    </button>
  );
}

function StatusBadge({
  httpStatus,
  verdict,
  message,
}: {
  httpStatus: number;
  verdict: PolicyVerdict;
  message: string;
}) {
  switch (verdict) {
    case "allowed":
      return <Badge variant="default">{httpStatus} allowed</Badge>;
    case "allowed-missing":
      return (
        <Badge variant="outline" title={message}>
          404 allowed*
        </Badge>
      );
    case "denied":
      return (
        <Badge variant="secondary" title={message}>
          403 denied
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" title={message}>
          {httpStatus || "err"}
        </Badge>
      );
  }
}

function Legend() {
  return (
    <div className="flex items-center gap-3 ml-auto text-xs text-muted-foreground">
      <span className="flex items-center gap-1">
        <Badge variant="default">2xx allowed</Badge>
        policy passed, op succeeded
      </span>
      <span className="flex items-center gap-1">
        <Badge variant="outline">404 allowed*</Badge>
        policy passed, probe file missing
      </span>
      <span className="flex items-center gap-1">
        <Badge variant="secondary">403 denied</Badge>
        policy rejection
      </span>
      <span className="flex items-center gap-1">
        <Badge variant="destructive">err</Badge>
        other failure
      </span>
    </div>
  );
}

function WhoAmI({ whoami }: { whoami: WhoAmI | null }) {
  if (!whoami) return null;
  return (
    <div className="mb-6 border rounded-md p-3 text-sm font-mono bg-muted/30">
      <div>
        <span className="text-muted-foreground">x-forwarded-user:</span>{" "}
        {whoami.xForwardedUser ?? "(none)"}
      </div>
      <div>
        <span className="text-muted-foreground">ADMIN_USER_ID:</span>{" "}
        {whoami.adminUserId ?? "(unset)"}
        {whoami.isAdmin && (
          <Badge variant="default" className="ml-2">
            admin
          </Badge>
        )}
      </div>
    </div>
  );
}

function SmokePanel({ title, body }: { title: string; body: string | null }) {
  return (
    <div className="border rounded-md p-3">
      <div className="font-semibold text-sm mb-2">{title}</div>
      <pre className="text-xs overflow-auto max-h-80 whitespace-pre-wrap">
        {body ?? "(not run)"}
      </pre>
    </div>
  );
}

/**
 * Maps a logical action to the concrete HTTP request the files plugin
 * exposes. Keeps this table in one place so the matrix stays honest
 * about what it's actually testing.
 */
function probe(volume: string, action: Action): Promise<Response> {
  const base = `/api/files/${volume}`;
  const qs = (params: Record<string, string>) =>
    new URLSearchParams(params).toString();

  switch (action) {
    case "list":
      return fetch(`${base}/list`);
    case "read":
      return fetch(`${base}/read?${qs({ path: PROBE_PATH })}`);
    case "download":
      return fetch(`${base}/download?${qs({ path: PROBE_PATH })}`);
    case "raw":
      return fetch(`${base}/raw?${qs({ path: PROBE_PATH })}`);
    case "exists":
      return fetch(`${base}/exists?${qs({ path: PROBE_PATH })}`);
    case "metadata":
      return fetch(`${base}/metadata?${qs({ path: PROBE_PATH })}`);
    case "preview":
      return fetch(`${base}/preview?${qs({ path: PROBE_PATH })}`);
    case "upload":
      return fetch(`${base}/upload?${qs({ path: PROBE_PATH })}`, {
        method: "POST",
        body: new Blob(["policy probe"], { type: "text/plain" }),
      });
    case "mkdir":
      return fetch(`${base}/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: PROBE_DIR }),
      });
    case "delete":
      return fetch(`${base}?${qs({ path: PROBE_PATH })}`, {
        method: "DELETE",
      });
  }
}
