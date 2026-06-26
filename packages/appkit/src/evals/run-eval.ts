import type {
  AssertionHandle,
  AssertionResult,
  EvalDefinition,
  EvalDriver,
  EvalResult,
  Matcher,
  TestContext,
} from "./types";

/** Thrown by `t.skip()` to unwind the test and mark the eval skipped. */
class SkipSignal extends Error {
  constructor(public reason?: string) {
    super("eval skipped");
    this.name = "SkipSignal";
  }
}

export interface RunEvalOptions {
  /** Stable id for the eval (e.g. its file path relative to the evals dir). */
  id: string;
  /** Drives the agent and returns reply/tool-calls/success per `send`. */
  driver: EvalDriver;
  /** When true, soft assertion failures also fail the eval. */
  strict?: boolean;
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
  let toolCalls: string[] = [];
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
        result.severity = "soft";
        result.pass = (result.score ?? (result.pass ? 1 : 0)) >= threshold;
        return handle;
      },
    };
    return handle;
  };

  const t: TestContext = {
    async send(message) {
      const r = await options.driver.send(message);
      reply = r.reply;
      toolCalls = r.toolCalls;
      sessionId = r.sessionId;
      lastSucceeded = r.succeeded;
      if (r.traceId) lastTraceId = r.traceId;
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
    check(value: string, matcher: Matcher) {
      const m = matcher(value);
      return record("check", m.pass, m.score, m.detail);
    },
    skip(reason) {
      throw new SkipSignal(reason);
    },
  };

  try {
    await def.test(t);
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
