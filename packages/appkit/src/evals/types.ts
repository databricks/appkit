/**
 * Agent evaluation primitives — an eve-style authoring API that runs against
 * AppKit agents and reports to Databricks MLflow.
 *
 * Evals live in `server/agents/<id>/evals/*.eval.ts`, each default-exporting a
 * {@link EvalDefinition} via {@link defineEval}. A runner drives the agent
 * (today over HTTP against a running app), and the `test` function asserts on
 * the reply and tool usage with deterministic matchers (and, later, LLM judges).
 */

/** Result of a deterministic matcher run against a value. */
export interface MatchResult {
  pass: boolean;
  /** Optional 0..1 score for scored matchers (similarity, judges). */
  score?: number;
  /** Human-readable explanation, shown on failure. */
  detail?: string;
}

/** A deterministic matcher: inspects a string value and returns a result. */
export type Matcher = (value: string) => MatchResult;

/** Whether an assertion fails the eval (`gate`) or is tracked only (`soft`). */
export type Severity = "gate" | "soft";

/** A single recorded assertion outcome. */
export interface AssertionResult {
  label: string;
  severity: Severity;
  pass: boolean;
  score?: number;
  detail?: string;
}

/**
 * Chainable handle returned by every assertion to control its severity.
 * Mirrors eve: assertions are gates by default; `.soft()` demotes to a tracked
 * metric; `.atLeast(n)` is a soft, score-thresholded assertion.
 */
export interface AssertionHandle {
  /** Promote to a hard gate — failure fails the eval (non-zero exit). */
  gate(): AssertionHandle;
  /** Demote to a tracked metric — doesn't fail unless running with `strict`. */
  soft(): AssertionHandle;
  /**
   * Set the pass threshold for a scored assertion: it passes only when the
   * score is at least `threshold`. Keeps the current severity (gate unless also
   * chained with `.soft()`).
   */
  atLeast(threshold: number): AssertionHandle;
}

/** What a driver returns for a single `t.send`. */
export interface DriveResult {
  /** The final assistant message text. */
  reply: string;
  /** Names of tools the agent called during the turn. */
  toolCalls: string[];
  /** Tool calls with their parsed arguments, in call order. */
  toolCallDetails: Array<{ name: string; args: Record<string, unknown> }>;
  /** Whether the turn completed without an agent/stream error. */
  succeeded: boolean;
  /** Thread/session id, when the driver exposes one. */
  sessionId?: string;
  /** MLflow trace id for the turn, when tracing is enabled on the app. */
  traceId?: string;
}

/**
 * Abstraction over how the agent is driven. The HTTP driver posts to a running
 * app's agents endpoint; future drivers (in-process) implement the same shape.
 */
export interface EvalDriver {
  send(message: string): Promise<DriveResult>;
  /**
   * Drop the current conversation so the next `send` starts a fresh thread.
   * Optional: drivers without a session concept omit it.
   */
  reset?(): void;
}

/** The `t` context passed to an eval's `test` function. */
export interface TestContext {
  /** Send a user message to the agent and capture its response. */
  send(message: string): Promise<void>;
  /**
   * Start a fresh conversation: the next `send` opens a new thread with no
   * history. Use to run several independent one-shot checks in one test.
   * Consecutive `send`s (without a `reset`) stay in one multi-turn conversation.
   */
  reset(): void;
  /** The last assistant reply. */
  readonly reply: string;
  /** Tools called during the last turn. */
  readonly toolCalls: string[];
  /** The current session/thread id, if any. */
  readonly sessionId: string | undefined;
  /**
   * The current dataset row's `inputs` when the eval is dataset-driven (see
   * {@link EvalDefinition.dataset}); `{}` for a plain single-run eval.
   */
  readonly input: Record<string, unknown>;
  /**
   * The current dataset row's `expectations` (ground truth / guidelines), or
   * `undefined` when the row has none or the eval isn't dataset-driven.
   */
  readonly expected: Record<string, unknown> | undefined;
  /** Assert the last turn completed successfully (gate by default). */
  succeeded(): AssertionHandle;
  /** Assert a tool was called during the run (gate by default). */
  calledTool(name: string): AssertionHandle;
  /**
   * Assert a tool was called with arguments that deep-contain `expected`: every
   * key in `expected` must equal the actual argument (recursively for nested
   * objects), so extra arguments are ignored. Gate by default.
   */
  calledToolWith(
    name: string,
    expected: Record<string, unknown>,
  ): AssertionHandle;
  /** Assert a value against a matcher, e.g. `t.check(t.reply, includes("Sunny"))`. */
  check(value: string, matcher: Matcher): AssertionHandle;
  /**
   * LLM-as-judge scoring of the last reply (via autoevals → a Databricks judge
   * model). Each returns a scored assertion that gates by default (a miss fails
   * the eval); chain `.atLeast(n)` to change the pass threshold or `.soft()` to
   * demote to a tracked-only metric. Requires the judge to be configured
   * (`--judge-model`).
   */
  judge: {
    /** Score factuality of the reply against an expected reference. */
    factuality(expected: string): Promise<AssertionHandle>;
    /** Score whether the reply answers the question, per optional `criteria`. */
    closedQA(criteria: string): Promise<AssertionHandle>;
    /** A custom prompt-template judge (the TS analog of MLflow's `@scorer`). */
    custom(spec: CustomJudgeSpec): Promise<AssertionHandle>;
  };
  /** Skip this eval with an optional reason. */
  skip(reason?: string): never;
}

/** A custom LLM-judge definition: a prompt template and choice→score mapping. */
export interface CustomJudgeSpec {
  name: string;
  promptTemplate: string;
  choiceScores: Record<string, number>;
}

/** A single eval, default-exported from a `*.eval.ts` file. */
export interface EvalDefinition {
  /** Short human description, shown in reports. */
  description?: string;
  /** Target agent id. Defaults to the eval's parent `server/agents/<id>` dir. */
  agent?: string;
  /** Free-form tags for filtering (see the runner's `tags` / `--tag` option). */
  tags?: string[];
  /**
   * Per-eval timeout (ms): `runEval` races the test against it and records a
   * non-passing result instead of hanging. Overrides the runner/CLI default.
   */
  timeoutMs?: number;
  /**
   * Run this eval once per row of a Databricks managed evaluation dataset (a
   * Unity Catalog `catalog.schema.table` with `inputs`/`expectations` columns).
   * Each row is bound to `t.input`/`t.expected`. Requires the runner to have a
   * workspace client + warehouse (`--warehouse`). Omit for a single-run eval.
   */
  dataset?: { table: string; limit?: number };
  /** The eval body: drive the agent and assert on its behavior. */
  test(t: TestContext): Promise<void> | void;
}

/**
 * Auto-start config for the app under test, à la Playwright's `webServer`. When
 * set in a root `evals.config.ts`, the CLI boots the app before running evals
 * and tears it down after — so you don't have to start the server by hand.
 */
export interface EvalWebServer {
  /** Shell command that starts the app, e.g. `"npm run dev"`. */
  command: string;
  /**
   * URL polled until it answers before evals start. Defaults to the run's
   * `baseUrl` (`--url`). Readiness = any HTTP response (a 404 still proves the
   * server is up).
   */
  url?: string;
  /** How long to wait for `url` to answer before giving up. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * When `true` (default), reuse a server already answering at `url` instead of
   * spawning one — so a running `dev` server is used as-is. Set `false` to
   * always spawn a fresh server.
   */
  reuseExisting?: boolean;
}

/**
 * Eval config from `evals.config.ts` (via {@link defineEvalConfig}).
 *
 * Two scopes share this shape: a **root** `evals.config.ts` (project root) may
 * set run-wide settings — `baseUrl` and `webServer` — plus defaults for
 * `maxConcurrency`/`timeoutMs`; a **per-agent** `server/agents/<id>/evals/evals.config.ts`
 * sets only that agent's `maxConcurrency`/`timeoutMs` overrides (`baseUrl`/
 * `webServer` there are ignored — server lifecycle is run-wide).
 */
export interface EvalConfig {
  /** LLM judge config. Defaults to the agent's own serving endpoint. */
  judge?: { model?: string };
  /** Max evals to run concurrently. */
  maxConcurrency?: number;
  /** Default per-eval timeout. */
  timeoutMs?: number;
  /** Base URL of the app to drive (root config only). Overridden by `--url`. */
  baseUrl?: string;
  /** Auto-start the app under test (root config only). */
  webServer?: EvalWebServer;
}

/** The outcome of running one eval. */
export interface EvalResult {
  id: string;
  description?: string;
  /** Set when the eval called `t.skip`. */
  skipped?: { reason?: string };
  assertions: AssertionResult[];
  /** True when all gates passed (and, under strict, all soft assertions too). */
  passed: boolean;
  /** Set when the eval threw before completing. */
  error?: string;
  /** MLflow trace id of the eval's last turn, for attaching assessments. */
  traceId?: string;
}
