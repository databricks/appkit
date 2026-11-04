import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Label,
  Spinner,
  Switch,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@databricks/appkit-ui/react";
import { Moon, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

type Result = {
  name: string;
  ttft?: number;
  fileWritten?: number;
  typecheckPassed?: number;
  rendered?: number;
  fixRounds: number;
  roundErrors?: string[][];
  status: "ok" | "failed";
  error?: string;
};
type Status = {
  prompt: string;
  answers: string;
  done: boolean;
  elapsed: number;
  results: Result[];
};
type Run = { id: string; running: boolean; error?: string };

const fmt = (n?: number) => (n === undefined ? "" : `${n.toFixed(1)}s`);

function phase(r: Result | undefined, running: boolean): string {
  if (!r) return running ? "waiting" : "";
  if (r.status === "failed") return "failed";
  if (r.rendered !== undefined) return `ready ${fmt(r.rendered)}`;
  if (r.typecheckPassed !== undefined)
    return r.name === "mock.ts"
      ? `done ${fmt(r.typecheckPassed)}`
      : "rendering";
  if (r.roundErrors?.length)
    return `fixing type errors (round ${r.roundErrors.length})`;
  if (r.fileWritten !== undefined) return "type-checking";
  if (r.ttft !== undefined) return "writing";
  return running ? "waiting" : "";
}

export function Builder() {
  const [prompt, setPrompt] = useState("");
  const [answers, setAnswers] = useState("");
  const [run, setRun] = useState<Run>();
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState(0);
  const [dark, setDark] = useState(false);
  const [error, setError] = useState<string>();

  const running = run?.running ?? false;

  // Restore the last run on load, then poll while one is in progress.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const body: { run?: Run; status: Status | null } = await fetch(
        "/api/drafts",
      ).then((r) => r.json());
      if (stop) return;
      setRun(body.run);
      setStatus(body.status);
      const last = body.status;
      if (last) {
        setPrompt((p) => p || last.prompt);
        setAnswers((a) => a || (last.answers ?? ""));
      }
      if (body.run?.running) setTimeout(tick, 500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [run?.id]); // re-arm polling whenever a new run starts

  async function generate() {
    setError(undefined);
    const res = await fetch("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, answers }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error);
      return;
    }
    setStatus(null);
    setSelected(0);
    setRun({ id: body.id, running: true });
  }

  const mock = status?.results[0];
  const drafts = status?.results.slice(1) ?? [];
  const current = drafts[selected];
  const ready =
    current?.typecheckPassed !== undefined && current.status === "ok";

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-96 shrink-0 flex-col gap-5 overflow-y-auto border-r p-5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">TSX draft builder</h1>
        </div>

        <div className="space-y-2">
          <Label htmlFor="prompt">What do you want to build?</Label>
          <Textarea
            id="prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A dashboard for NYC taxi trips"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="answers">Refinement answers</Label>
          <Textarea
            id="answers"
            rows={5}
            value={answers}
            onChange={(e) => setAnswers(e.target.value)}
            placeholder="Audience, key metrics, filters, screens..."
          />
        </div>
        <Button onClick={generate} disabled={running || !prompt.trim()}>
          {running ? <Spinner /> : <Sparkles />}
          {running ? "Generating drafts..." : "Generate 3 drafts"}
        </Button>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {run?.error && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-wrap font-mono text-xs">
              {run.error}
            </AlertDescription>
          </Alert>
        )}

        {(running || status) && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Progress</span>
              <span className="tabular-nums">{fmt(status?.elapsed)}</span>
            </div>
            {[
              { label: "Mock data", r: mock },
              ...["A", "B", "C"].map((l, i) => ({
                label: `Option ${l}`,
                r: drafts[i],
              })),
            ].map(({ label, r }) => (
              <div
                key={label}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="font-medium">{label}</span>
                <span
                  className={
                    r?.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {phase(r, running)}
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(selected)}
            onValueChange={(v) => v && setSelected(Number(v))}
          >
            {["A", "B", "C"].map((l, i) => (
              <ToggleGroupItem key={l} value={String(i)} className="gap-2 px-4">
                Option {l}
                {drafts[i]?.rendered !== undefined && (
                  <Badge variant="secondary">ready</Badge>
                )}
                {drafts[i]?.status === "failed" && (
                  <Badge variant="destructive">failed</Badge>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <Moon className="size-4 text-muted-foreground" />
            <Label htmlFor="dark">Dark preview</Label>
            <Switch id="dark" checked={dark} onCheckedChange={setDark} />
          </div>
        </div>

        <div className="flex-1 bg-muted/40 p-4">
          {ready ? (
            <iframe
              key={`${current.name}-${dark}`}
              title={`Option ${"ABC"[selected]}`}
              src={`/design/${current.name}${dark ? "?theme=dark" : ""}`}
              className="size-full rounded-lg border bg-background shadow-sm"
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-muted-foreground">
              {current?.status === "failed" ? (
                <p className="max-w-lg whitespace-pre-wrap text-center text-sm text-destructive">
                  {current.error}
                </p>
              ) : running ? (
                <>
                  <Spinner />
                  <p>Option {"ABC"[selected]} appears here once it compiles.</p>
                </>
              ) : (
                <p>Describe an app on the left and generate drafts.</p>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
