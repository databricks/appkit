import { describe, expect, test } from "vitest";

import type { MlflowClient } from "../../connectors/mlflow";
import { buildAssessments, reportToMlflow } from "../mlflow-report";
import type { EvalResult } from "../types";

describe("buildAssessments", () => {
  test("emits one feedback per assertion plus an overall appkit_eval", () => {
    const result: EvalResult = {
      id: "support/weather",
      traceId: "tr-123",
      assertions: [
        { label: "succeeded", severity: "gate", pass: true },
        {
          label: "judge.closedQA",
          severity: "soft",
          pass: true,
          score: 0.9,
          detail: "clearly relevant",
        },
      ],
      passed: true,
    };
    const out = buildAssessments(result);
    expect(out.map((a) => a.assessment_name)).toEqual([
      "succeeded",
      "judge_closedQA",
      "appkit_eval",
    ]);

    const judge = out.find((a) => a.assessment_name === "judge_closedQA");
    expect(judge?.source.source_type).toBe("LLM_JUDGE");
    expect(judge?.feedback.value).toBe(0.9); // numeric score, not boolean
    expect(judge?.rationale).toBe("clearly relevant");

    const succeeded = out.find((a) => a.assessment_name === "succeeded");
    expect(succeeded?.source.source_type).toBe("CODE");
    expect(succeeded?.feedback.value).toBe(true);

    const overall = out.find((a) => a.assessment_name === "appkit_eval");
    expect(overall?.feedback.value).toBe(true);
  });

  test("sanitizes and de-duplicates assertion names", () => {
    const out = buildAssessments({
      id: "x",
      traceId: "tr-1",
      assertions: [
        { label: "calledTool(get_weather)", severity: "gate", pass: true },
        { label: "check", severity: "gate", pass: true },
        { label: "check", severity: "gate", pass: true },
      ],
      passed: true,
    });
    const names = out.map((a) => a.assessment_name);
    expect(names).toContain("calledTool_get_weather_");
    expect(names).toContain("check");
    expect(names).toContain("check_2");
  });

  test("returns [] without a trace id or when skipped", () => {
    expect(buildAssessments({ id: "x", assertions: [], passed: true })).toEqual(
      [],
    );
    expect(
      buildAssessments({
        id: "x",
        traceId: "tr-1",
        assertions: [],
        passed: true,
        skipped: { reason: "no data" },
      }),
    ).toEqual([]);
  });

  test("does not leak result.error into the persisted overall rationale", () => {
    // The rationale is POSTed to MLflow and readable by anyone with experiment
    // access, so it must carry only a generic marker — never the raw error text.
    const out = buildAssessments({
      id: "x",
      traceId: "tr-1",
      assertions: [],
      passed: false,
      error: "secret detail: postgres://user:pw@host/db connection failed",
    });
    const overall = out.find((a) => a.assessment_name === "appkit_eval");
    expect(overall?.feedback.value).toBe(false);
    expect(overall?.rationale).toBe("eval errored");
    expect(overall?.rationale).not.toContain("secret detail");
  });
});

describe("reportToMlflow", () => {
  test("retries an assessment write on 404 until the trace is ingested", async () => {
    let calls = 0;
    const client = {
      // The first write 404s (the trace hasn't been ingested yet), then succeeds.
      postResult: async () => {
        calls++;
        return calls === 1
          ? { ok: false, status: 404, error: "not found" }
          : { ok: true };
      },
    } as unknown as MlflowClient;

    const result: EvalResult = {
      id: "query/sum",
      traceId: "tr-abc",
      assertions: [{ label: "reply", severity: "gate", pass: true }],
      passed: true,
    };

    const outcome = await reportToMlflow(client, [result]);
    // assertion + overall, both written after the one retry — no failures.
    expect(outcome.written).toBe(2);
    expect(outcome.failures).toEqual([]);
    expect(calls).toBe(3); // initial 404 + its retry + the other assessment
  });

  test("does not retry a non-404 failure", async () => {
    let calls = 0;
    const client = {
      postResult: async () => {
        calls++;
        return { ok: false, status: 403, error: "forbidden" };
      },
    } as unknown as MlflowClient;

    const outcome = await reportToMlflow(client, [
      {
        id: "x",
        traceId: "tr-1",
        assertions: [{ label: "reply", severity: "gate", pass: true }],
        passed: true,
      },
    ]);
    expect(outcome.written).toBe(0);
    expect(outcome.failures).toHaveLength(2); // both assessments failed, no retry
    expect(calls).toBe(2); // one call each, no retries
  });

  test("routes a UC V4 trace id to the V4 endpoint with a bare assessment body", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = {
      postResult: async (path: string, body: unknown) => {
        calls.push({ path, body });
        return { ok: true };
      },
    } as unknown as MlflowClient;

    await reportToMlflow(client, [
      {
        id: "query/sum",
        traceId: "trace:/main.mario.2132184224222661/68b727fb0e5493f9",
        assertions: [{ label: "reply", severity: "gate", pass: true }],
        passed: true,
      },
    ]);

    expect(calls).toHaveLength(2); // assertion + overall
    for (const c of calls) {
      // location + bare hex as separate path segments; no `trace:/` prefix.
      expect(c.path).toBe(
        "/api/4.0/mlflow/traces/main.mario.2132184224222661/68b727fb0e5493f9/assessments",
      );
      // V4 body is the bare assessment, NOT wrapped in { assessment }.
      expect(c.body).toHaveProperty("trace_id");
      expect(c.body).not.toHaveProperty("assessment");
    }
  });

  test("appends sql_warehouse_id to the V4 endpoint when provided", async () => {
    const calls: string[] = [];
    const client = {
      postResult: async (path: string) => {
        calls.push(path);
        return { ok: true };
      },
    } as unknown as MlflowClient;

    await reportToMlflow(
      client,
      [
        {
          id: "query/sum",
          traceId: "trace:/main.mario.2132184224222661/68b727fb0e5493f9",
          assertions: [{ label: "reply", severity: "gate", pass: true }],
          passed: true,
        },
      ],
      "abc123warehouse",
    );

    expect(calls).toHaveLength(2);
    for (const path of calls) {
      expect(path).toBe(
        "/api/4.0/mlflow/traces/main.mario.2132184224222661/68b727fb0e5493f9/assessments?sql_warehouse_id=abc123warehouse",
      );
    }
  });

  test("routes a classic V3 trace id to the V3 endpoint with a wrapped body", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = {
      postResult: async (path: string, body: unknown) => {
        calls.push({ path, body });
        return { ok: true };
      },
    } as unknown as MlflowClient;

    await reportToMlflow(client, [
      {
        id: "x",
        traceId: "tr-abc",
        assertions: [{ label: "reply", severity: "gate", pass: true }],
        passed: true,
      },
    ]);

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.path).toBe("/api/3.0/mlflow/traces/tr-abc/assessments");
      expect(c.body).toHaveProperty("assessment"); // V3 wraps in { assessment }
    }
  });
});
