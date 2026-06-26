/**
 * Agent evaluation primitives — an eve-style authoring API that runs against
 * AppKit agents and reports to Databricks MLflow.
 *
 * Evals live in `config/agents/<id>/evals/*.eval.ts`, each default-exporting a
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
  /** Soft assertion that passes only when the score is at least `threshold`. */
  atLeast(threshold: number): AssertionHandle;
}

/** What a driver returns for a single `t.send`. */
export interface DriveResult {
  /** The final assistant message text. */
  reply: string;
  /** Names of tools the agent called during the turn. */
  toolCalls: string[];
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
}

/** The `t` context passed to an eval's `test` function. */
export interface TestContext {
  /** Send a user message to the agent and capture its response. */
  send(message: string): Promise<void>;
  /** The last assistant reply. */
  readonly reply: string;
  /** Tools called during the last turn. */
  readonly toolCalls: string[];
  /** The current session/thread id, if any. */
  readonly sessionId: string | undefined;
  /** Assert the last turn completed successfully (gate by default). */
  succeeded(): AssertionHandle;
  /** Assert a tool was called during the run (gate by default). */
  calledTool(name: string): AssertionHandle;
  /** Assert a value against a matcher, e.g. `t.check(t.reply, includes("Sunny"))`. */
  check(value: string, matcher: Matcher): AssertionHandle;
  /** Skip this eval with an optional reason. */
  skip(reason?: string): never;
}

/** A single eval, default-exported from a `*.eval.ts` file. */
export interface EvalDefinition {
  /** Short human description, shown in reports. */
  description?: string;
  /** Target agent id. Defaults to the eval's parent `config/agents/<id>` dir. */
  agent?: string;
  /** Free-form tags for filtering. */
  tags?: string[];
  /** Per-eval timeout. */
  timeoutMs?: number;
  /** The eval body: drive the agent and assert on its behavior. */
  test(t: TestContext): Promise<void> | void;
}

/** Per-directory config from `evals.config.ts`. */
export interface EvalConfig {
  /** LLM judge config. Defaults to the agent's own serving endpoint. */
  judge?: { model?: string };
  /** Max evals to run concurrently. */
  maxConcurrency?: number;
  /** Default per-eval timeout. */
  timeoutMs?: number;
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
