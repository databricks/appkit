import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@databricks/appkit-ui/react";
import { useAiFunction } from "@databricks/appkit-ui/react/beta";
import { createFileRoute } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Header } from "@/components/layout/header";

import {
  EXAMPLES,
  type Example,
  FUNCTION_INFO,
  type FunctionName,
} from "../../../shared/ai-functions-examples";

export const Route = createFileRoute("/ai-functions")({
  component: AiFunctionsRoute,
});

type RunAs = "user" | "sp";
type RunMode = RunAs | "both";

const RUN_MODE_HINT: Record<RunMode, string> = {
  user: "Runs the example's named task as you (POST /api/ai-functions/:task/invoke). Edited requests use a demo-only route.",
  sp: "Sends the request to a demo-only route that calls appkit.aiFunctions as the app service principal.",
  both: "Runs both ways so you can compare the results.",
};

interface Identity {
  user: string | null;
  userTokenPresent: boolean;
}

interface RunResult {
  fn: FunctionName;
  runAs: RunAs;
  url: string;
  request: Record<string, unknown>;
  status: number;
  ms: number;
  body: Record<string, unknown> | null;
}

type Target =
  | { kind: "task"; runAs: RunAs; task: string; body: Record<string, unknown> }
  | {
      kind: "demo";
      runAs: RunAs;
      mode: "as-user" | "as-sp";
      body: Record<string, unknown>;
    };

function targetUrl(fn: FunctionName, target: Target): string {
  return target.kind === "task"
    ? `/api/ai-functions/${encodeURIComponent(target.task)}/invoke`
    : `/api/ai-functions-demo/${fn}/${target.mode}`;
}

/** Edited requests and the service-principal mode use the demo routes. */
function targetFor(
  fn: FunctionName,
  runAs: RunAs,
  example: Example,
  edited: boolean,
  text: string,
  request: Record<string, unknown>,
): Target {
  if (runAs === "sp")
    return { kind: "demo", runAs, mode: "as-sp", body: request };
  if (edited) return { kind: "demo", runAs, mode: "as-user", body: request };
  return {
    kind: "task",
    runAs,
    task: example.id,
    body: { [FUNCTION_INFO[fn].textField]: text },
  };
}

async function callAiFunction(
  fn: FunctionName,
  target: Target,
  signal: AbortSignal,
): Promise<RunResult> {
  const url = targetUrl(fn, target);
  const started = performance.now();
  const result = { fn, runAs: target.runAs, url, request: target.body };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target.body),
      signal,
    });
    const body = await res.json().catch(() => null);
    return {
      ...result,
      status: res.status,
      ms: Math.round(performance.now() - started),
      body,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    // Network failure: report it like an HTTP error so the result pane shows it.
    return {
      ...result,
      status: 0,
      ms: Math.round(performance.now() - started),
      body: {
        error: error instanceof Error ? error.message : "Network error",
      },
    };
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function AiFunctionsRoute() {
  const [fn, setFn] = useState<FunctionName>("classify");
  const [example, setExample] = useState<Example>(EXAMPLES.classify[0]);
  const [text, setText] = useState(example.text);
  const [optionsJson, setOptionsJson] = useState(toJson(example.options));
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [runAs, setRunAs] = useState<RunMode>("user");
  const [results, setResults] = useState<RunResult[]>([]);
  // The prompt-injection check is a plain named task, so it uses the hook.
  const injectionCheck = useAiFunction("promptInjectionCheck");
  const [showInjection, setShowInjection] = useState(false);
  const runController = useRef<AbortController | null>(null);

  // Cancel an in-flight run when the page unmounts.
  useEffect(() => () => runController.current?.abort(), []);
  const [checkInjection, setCheckInjection] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ai-functions-demo/identity")
      .then((res) => res.json())
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, []);

  function selectExample(next: Example) {
    setExample(next);
    setText(next.text);
    setOptionsJson(toJson(next.options));
    setResults([]);
    setShowInjection(false);
    setParseError(null);
  }

  function selectFunction(next: FunctionName) {
    setFn(next);
    selectExample(EXAMPLES[next][0]);
  }

  async function run() {
    const targets: RunAs[] = runAs === "both" ? ["user", "sp"] : [runAs];
    let options: Record<string, unknown>;
    try {
      options = JSON.parse(optionsJson);
    } catch {
      setParseError("Request options are not valid JSON.");
      return;
    }
    setParseError(null);
    setLoading(true);
    // A new run replaces any earlier one, so stale responses never land.
    runController.current?.abort();
    const controller = new AbortController();
    runController.current = controller;
    const { signal } = controller;
    const request = { [FUNCTION_INFO[fn].textField]: text, ...options };
    try {
      const edited = optionsJson !== toJson(example.options);
      const [runs] = await Promise.all([
        Promise.all(
          targets.map((t) =>
            callAiFunction(
              fn,
              targetFor(fn, t, example, edited, text, request),
              signal,
            ),
          ),
        ),
        checkInjection ? injectionCheck.invoke({ content: text }) : null,
      ]);
      setShowInjection(checkInjection);
      setResults(runs);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (runController.current === controller) setLoading(false);
    }
  }

  const info = FUNCTION_INFO[fn];

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-7xl mx-auto px-6 py-8">
        <Header
          title="AI Functions"
          description="Describe a task with labels, a schema, or questions, and get structured JSON back."
          tooltip="Examples run as named tasks (POST /api/ai-functions/:task/invoke) as the signed-in user. Edited requests and the service-principal mode use demo-only routes. Those are mounted only in development or with AIFN_DEMO_ROUTES=1."
        />

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <Card>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <Tabs
                  value={fn}
                  onValueChange={(value) =>
                    selectFunction(value as FunctionName)
                  }
                >
                  <TabsList>
                    <TabsTrigger value="classify">Classify</TabsTrigger>
                    <TabsTrigger value="extract">Extract</TabsTrigger>
                    <TabsTrigger value="decide">Decide</TabsTrigger>
                  </TabsList>
                </Tabs>
                <p className="text-sm text-muted-foreground">{info.summary}</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Example</span>
                <Select
                  value={example.id}
                  onValueChange={(id) => {
                    const next = EXAMPLES[fn].find((ex) => ex.id === id);
                    if (next) selectExample(next);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXAMPLES[fn].map((ex) => (
                      <SelectItem key={ex.id} value={ex.id}>
                        {ex.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {example.shows}
                </span>
              </div>

              <div className="flex flex-col gap-4">
                <Field
                  id="ai-functions-text"
                  label="Input text"
                  hint="What the function reads. Edit it to try your own."
                >
                  <Textarea
                    id="ai-functions-text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="min-h-32"
                  />
                </Field>
                <Field
                  id="ai-functions-options"
                  label={info.taskLabel}
                  hint="Tells the function what to do. Edit as JSON."
                >
                  <Textarea
                    id="ai-functions-options"
                    value={optionsJson}
                    onChange={(e) => setOptionsJson(e.target.value)}
                    className="min-h-56 max-h-96 font-mono text-xs"
                  />
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                <span className="text-sm font-medium">Run as</span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={runAs}
                  onValueChange={(value) => value && setRunAs(value as RunMode)}
                >
                  <ToggleGroupItem value="user">You</ToggleGroupItem>
                  <ToggleGroupItem value="sp">
                    Service principal
                  </ToggleGroupItem>
                  <ToggleGroupItem value="both">Both</ToggleGroupItem>
                </ToggleGroup>
                <Button onClick={run} disabled={loading} className="ml-auto">
                  <Play className="h-4 w-4 mr-2" />
                  {loading ? "Running..." : "Run"}
                </Button>
              </div>
              <p className="-mt-3 text-xs text-muted-foreground">
                {RUN_MODE_HINT[runAs]}
                {identity && !identity.userTokenPresent && runAs !== "sp"
                  ? " Running locally with no user token, so this also runs as the service principal."
                  : ""}
              </p>
              <div className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  id="check-injection"
                  checked={checkInjection}
                  onCheckedChange={(checked) =>
                    setCheckInjection(checked === true)
                  }
                />
                <label htmlFor="check-injection">
                  Also check the input for prompt injection (runs once, as the
                  app service principal).
                </label>
              </div>
              {parseError && <ErrorBox message={parseError} />}
            </CardContent>
          </Card>

          <section className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <h2 className="text-sm font-medium">Results</h2>
            {loading && (
              <p className="text-sm text-muted-foreground">Running...</p>
            )}
            {!loading && results.length === 0 && <EmptyResults />}
            {!loading &&
              showInjection &&
              (injectionCheck.data || injectionCheck.error) && (
                <div className="mb-3">
                  <InjectionCheck
                    data={injectionCheck.data}
                    error={injectionCheck.error}
                  />
                </div>
              )}
            {!loading &&
              results.map((result) => (
                <ResultCard key={result.runAs} result={result} text={text} />
              ))}
          </section>
        </div>
      </main>
    </div>
  );
}

function EmptyResults() {
  return (
    <Card className="border-dashed">
      <CardContent className="text-sm">
        <p className="mb-2">
          Pick an example and select <span className="font-medium">Run</span>.
          Results appear here.
        </p>
        <p className="font-medium mb-2">What AI Functions give you</p>
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li>
            No prompt to write or parse: each function takes a task definition
            and returns JSON in a fixed shape.
          </li>
          <li>
            Evidence on request: confidence scores, rationales (classify), and
            citations into the source text (extract).
          </li>
          <li>
            Numbers your code can act on: the badges show a sample rule that
            acts on its own at 80% or higher and sends the rest to a person.
          </li>
          <li>
            Typed extraction: a schema with types and nested lists returns
            numbers and arrays, not only strings.
          </li>
          <li>
            Pinned versions: the plugin sends a fixed function version, shown on
            each result. Databricks can still update the model behind it.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <span className="text-xs text-muted-foreground">{hint}</span>
      {children}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive mb-4">
      {message}
    </div>
  );
}

interface ClassifyItem {
  value: string;
  confidence_score?: number;
  rationale?: string;
}

function InjectionCheck({
  data,
  error,
}: {
  data: unknown;
  error: string | null;
}) {
  const top = (data as { response?: ClassifyItem[] } | null)?.response?.[0];
  if (error || !top) {
    return (
      <p className="text-xs text-muted-foreground">
        Prompt injection check failed{error ? `: ${error}` : ""}
      </p>
    );
  }
  const flagged = top.value === "prompt_injection";
  return (
    <p
      title={top.rationale}
      className={`text-xs ${flagged ? "text-destructive font-medium" : "text-muted-foreground"}`}
    >
      Prompt injection: {flagged ? "detected" : "not detected"}
      {top.confidence_score !== undefined && ` (${pct(top.confidence_score)})`}
    </p>
  );
}

function ResultCard({ result, text }: { result: RunResult; text: string }) {
  const ok = result.status >= 200 && result.status < 300;
  const metadata = result.body?.metadata as ResultMetadata | undefined;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between text-sm">
          <Badge
            variant="outline"
            className="font-normal text-muted-foreground"
            title="Identity the request ran as"
          >
            {result.runAs === "user" ? "You" : "Service principal"}
          </Badge>
          <span className="ml-auto text-muted-foreground">
            HTTP {result.status} &middot; {result.ms}ms
            {metadata?.version ? ` · v${metadata.version}` : ""}
          </span>
        </div>

        {ok ? (
          <ResultView
            fn={result.fn}
            response={result.body?.response}
            metadata={metadata}
            text={text}
          />
        ) : (
          <ErrorBox
            message={String(result.body?.error ?? `HTTP ${result.status}`)}
          />
        )}

        <Details summary={`Request sent: POST ${result.url}`}>
          {toJson(result.request)}
        </Details>
        <Details summary="Raw response">{toJson(result.body)}</Details>
      </CardContent>
    </Card>
  );
}

function Details({ summary, children }: { summary: string; children: string }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {summary}
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3">
        {children}
      </pre>
    </details>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Meter({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex justify-between gap-4">
        <span>{label}</span>
        {value !== undefined && (
          <span className="text-muted-foreground">{pct(value)}</span>
        )}
      </div>
      {value !== undefined && <Progress value={value * 100} />}
    </div>
  );
}

interface ResultMetadata {
  version?: string;
  citations?: Array<{ id: number; start?: number; stop?: number }>;
}

function ResultView({
  fn,
  response,
  metadata,
  text,
}: {
  fn: FunctionName;
  response: unknown;
  metadata?: ResultMetadata;
  text: string;
}) {
  if (response === undefined || response === null) {
    return <p className="text-sm text-muted-foreground">No response.</p>;
  }
  if (fn === "classify" && Array.isArray(response)) {
    return <ClassifyView items={response as ClassifyItem[]} />;
  }
  if (fn === "extract" && typeof response === "object") {
    const citations = (metadata?.citations ?? []).filter(
      (c) => c.start !== undefined && c.stop !== undefined,
    );
    return (
      <div className="flex flex-col gap-3">
        <FieldList fields={response as Record<string, unknown>} />
        {citations.length > 0 && (
          <div className="border-t pt-3 text-xs">
            <p className="mb-1 font-medium">Citations (spans of the input)</p>
            <ol className="flex flex-col gap-1 text-muted-foreground">
              {citations.map((c) => (
                <li key={c.id}>
                  <span className="font-mono">[{c.id}]</span> "
                  {text.slice(c.start, c.stop).trim()}"
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    );
  }
  if (fn === "decide" && typeof response === "object") {
    const answers = (response as { answers?: Record<string, DecideAnswer> })
      .answers;
    return <DecideView answers={answers ?? {}} />;
  }
  return null;
}

const ACT_THRESHOLD = 0.8;

function ActionBadge({
  value,
  yesNo = false,
}: {
  value?: number;
  yesNo?: boolean;
}) {
  if (value === undefined) return null;
  let label = "Needs review";
  if (yesNo && value >= ACT_THRESHOLD) label = "Yes";
  else if (yesNo && value <= 1 - ACT_THRESHOLD) label = "No";
  else if (!yesNo && value >= ACT_THRESHOLD) label = "Auto";
  return (
    <Badge
      variant={label === "Needs review" ? "outline" : "secondary"}
      title={`Sample rule: act at ${pct(ACT_THRESHOLD)} or higher, otherwise send to a person`}
    >
      {label}
    </Badge>
  );
}

function ClassifyView({ items }: { items: ClassifyItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.value} className="flex flex-col gap-1">
          <ActionBadge value={item.confidence_score} />
          <Meter label={item.value} value={item.confidence_score} />
          {item.rationale && (
            <p className="text-xs text-muted-foreground">{item.rationale}</p>
          )}
        </div>
      ))}
    </div>
  );
}

interface ExtractLeaf {
  value: unknown;
  confidence_score?: number;
  citation_ids?: number[];
}

function isLeaf(value: unknown): value is ExtractLeaf {
  return typeof value === "object" && value !== null && "value" in value;
}

function FieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {Object.entries(fields).map(([name, field]) => (
        <div key={name}>
          {isLeaf(field) ? (
            <div className="flex flex-col">
              <div className="flex gap-3">
                <dt className="min-w-32 font-medium text-muted-foreground">
                  {name}
                </dt>
                <dd className="flex-1 break-all">
                  {typeof field.value === "string"
                    ? field.value
                    : JSON.stringify(field.value)}
                  {typeof field.value !== "string" && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (
                      {Array.isArray(field.value) ? "list" : typeof field.value}
                      )
                    </span>
                  )}
                  {field.citation_ids?.length ? (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {field.citation_ids.map((id) => `[${id}]`).join("")}
                    </span>
                  ) : null}
                </dd>
                {field.confidence_score !== undefined && (
                  <dd className="text-muted-foreground">
                    {pct(field.confidence_score)}
                  </dd>
                )}
              </div>
            </div>
          ) : Array.isArray(field) ? (
            <>
              <dt className="font-medium text-muted-foreground">
                {name} ({field.length} items)
              </dt>
              {field.map((item, index) => (
                <dd key={index} className="mt-2 ml-4 border-l pl-3">
                  <FieldList fields={item as Record<string, unknown>} />
                </dd>
              ))}
            </>
          ) : (
            <>
              <dt className="font-medium text-muted-foreground">{name}</dt>
              <dd className="text-xs">{JSON.stringify(field)}</dd>
            </>
          )}
        </div>
      ))}
    </dl>
  );
}

type DecideAnswer =
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: "noul"; probability: number }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, unknown>;
    };

function DecideView({ answers }: { answers: Record<string, DecideAnswer> }) {
  return (
    <div className="flex flex-col gap-4">
      {Object.entries(answers).map(([name, answer]) => (
        <div key={name} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{answer.type}</Badge>
            <span>{name}</span>
            <span className="ml-auto">
              <ActionBadge
                value={
                  answer.type === "noul"
                    ? answer.probability
                    : answer.confidence
                }
                yesNo={answer.type === "noul"}
              />
            </span>
          </div>
          {answer.type === "choice" && (
            <>
              <Meter
                label={`Choice: ${answer.choice}`}
                value={answer.confidence}
              />
              <p className="text-xs text-muted-foreground">
                Probabilities:{" "}
                {Object.entries(answer.probabilities)
                  .map(([option, p]) => `${option} ${pct(p)}`)
                  .join(", ")}
              </p>
            </>
          )}
          {answer.type === "noul" && (
            <Meter
              label={`Probability true: ${answer.probability >= 0.5 ? "likely" : "unlikely"}`}
              value={answer.probability}
            />
          )}
          {answer.type === "score" && (
            <>
              <Meter
                label={`Score: ${answer.score.toFixed(1)} on a 0 to ${Object.keys(answer.legend).length - 1} scale, closest to "${String(answer.legend[String(Math.round(answer.score))] ?? "")}"`}
                value={answer.confidence}
              />
              <p className="text-xs text-muted-foreground">
                Scale:{" "}
                {Object.entries(answer.legend)
                  .map(([k, v]) => `${k} ${String(v)}`)
                  .join(", ")}
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
