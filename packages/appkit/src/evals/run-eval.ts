import type { DatasetRow } from "./dataset";
import { judgeClosedQA, judgeCustom, judgeFactuality } from "./judge";
import type {
  AssertionHandle,
  AssertionResult,
  DriveResult,
  EvalDefinition,
  EvalDriver,
  EvalResult,
  Matcher,
  TestContext,
} from "./types";

/** Default pass threshold for an LLM-judge score (0..1) before `.atLeast()`. */
const DEFAULT_JUDGE_THRESHOLD = 0.5;

/** Thrown by `t.skip()` to unwind the test and mark the eval skipped. */
class SkipSignal extends Error {
  constructor(public reason?: string) {
    super("eval skipped");
    this.name = "SkipSignal";
  }
}

/** Rejects the test race when a per-eval timeout elapses. */
class TimeoutSignal extends Error {
  constructor(ms: number) {
    super(`eval timed out after ${ms}ms`);
    this.name = "TimeoutSignal";
  }
}

/**
 * Deep partial match: every key in `expected` is present in `actual` and equal,
 * recursing into nested plain objects so extra actual keys are ignored.
 */
function deepContains(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((key) =>
      deepContains(actual[key], expected[key]),
    );
  }
  return actual === expected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RunEvalOptions {
  /** Stable id for the eval (e.g. its file path relative to the evals dir). */
  id: string;
  /** Drives the agent and returns reply/tool-calls/success per `send`. */
  driver: EvalDriver;
  /** When true, soft assertion failures also fail the eval. */
  strict?: boolean;
  /** Dataset row bound to `t.input`/`t.expected` for dataset-driven evals. */
  row?: DatasetRow;
  /**
   * Runner-level default per-eval timeout (ms). `def.timeoutMs` wins over this;
   * when both are unset the eval runs unbounded (current behavior).
   */
  timeoutMs?: number;
}

/**
 * Run a single eval against a driver. Never throws for assertion or agent
 * failures — those become a non-passing {@link EvalResult}. Only a malformed
 * eval definition surfaces as `result.error`.
 */
export async function runEval(
  def: EvalDefinition,
  options: RunEvalOptions,
): Promise<EvalResult> {
  const assertions: AssertionResult[] = [];
  let reply = "";
  let lastInput = "";
  let toolCalls: string[] = [];
  let toolCallDetails: DriveResult["toolCallDetails"] = [];
  let sessionId: string | undefined;
  let lastTraceId: string | undefined;
  let lastSucceeded = false;

  const record = (
    label: string,
    pass: boolean,
    score?: number,
    detail?: string,
  ): AssertionHandle => {
    const result: AssertionResult = {
      label,
      severity: "gate",
      pass,
      score,
      detail,
    };
    assertions.push(result);
    const handle: AssertionHandle = {
      gate() {
        result.severity = "gate";
        return handle;
      },
      soft() {
        result.severity = "soft";
        return handle;
      },
      atLeast(threshold: number) {
        // Re-threshold the score; keep the current severity (gate unless the
        // caller also chained `.soft()`).
        result.pass = (result.score ?? (result.pass ? 1 : 0)) >= threshold;
        return handle;
      },
    };
    return handle;
  };

  // LLM-judge assertions are scored and gate by default (a miss fails the eval,
  // like other assertions). The caller chains `.atLeast(n)` to change the pass
  // threshold, or `.soft()` to demote to a tracked-only metric.
  const recordJudge = (
    label: string,
    score: number,
    rationale?: string,
  ): AssertionHandle =>
    record(label, score >= DEFAULT_JUDGE_THRESHOLD, score, rationale);

  const t: TestContext = {
    async send(message) {
      lastInput = message;
      const r = await options.driver.send(message);
      reply = r.reply;
      toolCalls = r.toolCalls;
      toolCallDetails = r.toolCallDetails;
      sessionId = r.sessionId;
      lastSucceeded = r.succeeded;
      if (r.traceId) lastTraceId = r.traceId;
    },
    reset() {
      options.driver.reset?.();
    },
    get reply() {
      return reply;
    },
    get toolCalls() {
      return toolCalls;
    },
    get sessionId() {
      return sessionId;
    },
    get input() {
      return options.row?.inputs ?? {};
    },
    get expected() {
      return options.row?.expectations;
    },
    succeeded() {
      return record(
        "succeeded",
        lastSucceeded,
        undefined,
        lastSucceeded ? undefined : "agent turn did not complete successfully",
      );
    },
    calledTool(name) {
      return record(
        `calledTool(${name})`,
        toolCalls.includes(name),
        undefined,
        `expected tool "${name}" to be called (called: ${
          toolCalls.length ? toolCalls.join(", ") : "none"
        })`,
      );
    },
    calledToolWith(name, expected) {
      const matching = toolCallDetails.filter((c) => c.name === name);
      const pass = matching.some((c) => deepContains(c.args, expected));
      const seen = matching.length
        ? matching.map((c) => JSON.stringify(c.args)).join(", ")
        : "not called";
      return record(
        `calledToolWith(${name})`,
        pass,
        undefined,
        `expected tool "${name}" to be called with ${JSON.stringify(
          expected,
        )} (args seen: ${seen})`,
      );
    },
    check(value: string, matcher: Matcher) {
      const m = matcher(value);
      return record("check", m.pass, m.score, m.detail);
    },
    judge: {
      async factuality(expected) {
        const { score, rationale } = await judgeFactuality({
          input: lastInput,
          output: reply,
          expected,
        });
        return recordJudge("judge.factuality", score, rationale);
      },
      async closedQA(criteria) {
        const { score, rationale } = await judgeClosedQA({
          input: lastInput,
          output: reply,
          criteria,
        });
        return recordJudge("judge.closedQA", score, rationale);
      },
      async custom(spec) {
        const { score, rationale } = await judgeCustom(spec, {
          input: lastInput,
          output: reply,
        });
        return recordJudge(`judge.${spec.name}`, score, rationale);
      },
    },
    skip(reason) {
      throw new SkipSignal(reason);
    },
  };

  // `def.timeoutMs` (per-eval) wins over the runner default; when both are
  // unset the eval runs unbounded (undefined = no timeout).
  const timeoutMs = def.timeoutMs ?? options.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (timeoutMs === undefined) {
      await def.test(t);
    } else {
      // Race the test against a timeout; on elapse the sentinel rejects and we
      // convert it to a non-passing result. The timer is cleared in `finally`
      // so it can't keep the process alive after the test settles.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutSignal(timeoutMs)),
          timeoutMs,
        );
      });
      await Promise.race([Promise.resolve(def.test(t)), timeout]);
    }
  } catch (err) {
    if (err instanceof SkipSignal) {
      return {
        id: options.id,
        description: def.description,
        skipped: { reason: err.reason },
        assertions,
        passed: true,
        traceId: lastTraceId,
      };
    }
    return {
      id: options.id,
      description: def.description,
      assertions,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      traceId: lastTraceId,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const passed = assertions.every(
    (a) => a.pass || (a.severity === "soft" && !options.strict),
  );

  return {
    id: options.id,
    description: def.description,
    assertions,
    passed,
    traceId: lastTraceId,
  };
}
