import { describe, expect, test, vi } from "vitest";
import { defineEval } from "../define-eval";
import { includes } from "../matchers";
import { runEval } from "../run-eval";
import type { DriveResult, EvalDriver } from "../types";

/** Driver that returns a fixed result for every send. */
function fakeDriver(result: Partial<DriveResult>): EvalDriver {
  return {
    send: async () => ({
      reply: "",
      toolCalls: [],
      toolCallDetails: [],
      succeeded: true,
      ...result,
    }),
  };
}

describe("runEval", () => {
  test("passes when all gate assertions pass", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("weather?");
        t.succeeded();
        t.calledTool("get_weather");
        t.check(t.reply, includes("Sunny"));
      },
    });
    const result = await runEval(def, {
      id: "weather",
      driver: fakeDriver({
        reply: "It is Sunny",
        toolCalls: ["get_weather"],
        succeeded: true,
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(3);
    expect(result.assertions.every((a) => a.pass)).toBe(true);
  });

  test("fails when a gate assertion fails", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("weather?");
        t.calledTool("get_weather");
      },
    });
    const result = await runEval(def, {
      id: "no-tool",
      driver: fakeDriver({ reply: "I don't know", toolCalls: [] }),
    });
    expect(result.passed).toBe(false);
    expect(result.assertions[0].pass).toBe(false);
  });

  test("calledToolWith passes when a call's args deep-contain the expected", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("weather in Paris?");
        t.calledToolWith("get_weather", { city: "Paris" });
      },
    });
    const result = await runEval(def, {
      id: "args-match",
      driver: fakeDriver({
        toolCalls: ["get_weather"],
        toolCallDetails: [
          { name: "get_weather", args: { city: "Paris", units: "metric" } },
        ],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.assertions[0].pass).toBe(true);
  });

  test("calledToolWith fails when the tool was called with different args", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("weather in Paris?");
        t.calledToolWith("get_weather", { city: "Paris" });
      },
    });
    const result = await runEval(def, {
      id: "args-mismatch",
      driver: fakeDriver({
        toolCalls: ["get_weather"],
        toolCallDetails: [{ name: "get_weather", args: { city: "London" } }],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.assertions[0].pass).toBe(false);
  });

  test("calledToolWith fails when the tool was not called", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("hi");
        t.calledToolWith("get_weather", { city: "Paris" });
      },
    });
    const result = await runEval(def, {
      id: "args-not-called",
      driver: fakeDriver({ toolCalls: [], toolCallDetails: [] }),
    });
    expect(result.passed).toBe(false);
    expect(result.assertions[0].pass).toBe(false);
    expect(result.assertions[0].detail).toContain("not called");
  });

  test("calledToolWith matches nested args and ignores extra keys", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("book it");
        t.calledToolWith("book", { where: { city: "Paris" } });
      },
    });
    const result = await runEval(def, {
      id: "args-nested",
      driver: fakeDriver({
        toolCalls: ["book"],
        toolCallDetails: [
          {
            name: "book",
            args: { where: { city: "Paris", zip: "75001" }, when: "today" },
          },
        ],
      }),
    });
    expect(result.passed).toBe(true);
  });

  test("soft failures don't fail the eval unless strict", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("hi");
        t.calledTool("get_weather").soft();
      },
    });
    const lenient = await runEval(def, {
      id: "soft",
      driver: fakeDriver({ toolCalls: [] }),
    });
    expect(lenient.passed).toBe(true);

    const strict = await runEval(def, {
      id: "soft",
      driver: fakeDriver({ toolCalls: [] }),
      strict: true,
    });
    expect(strict.passed).toBe(false);
  });

  test("succeeded() reflects the driver's success flag", async () => {
    const def = defineEval({
      async test(t) {
        await t.send("hi");
        t.succeeded();
      },
    });
    const result = await runEval(def, {
      id: "failed-turn",
      driver: fakeDriver({ succeeded: false }),
    });
    expect(result.passed).toBe(false);
  });

  test("t.skip marks the eval skipped and passing", async () => {
    const def = defineEval({
      test(t) {
        t.skip("no fixture data");
      },
    });
    const result = await runEval(def, {
      id: "skipped",
      driver: fakeDriver({}),
    });
    expect(result.skipped?.reason).toBe("no fixture data");
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(0);
  });

  test("a thrown error becomes a non-passing result, not an exception", async () => {
    const def = defineEval({
      async test() {
        throw new Error("boom");
      },
    });
    const result = await runEval(def, { id: "boom", driver: fakeDriver({}) });
    expect(result.passed).toBe(false);
    expect(result.error).toBe("boom");
  });

  test("atLeast() gates by default — a below-threshold score fails the eval", async () => {
    // A scored matcher standing in for a judge (which shares the same handle).
    const scored = (score: number) => (): { pass: boolean; score: number } => ({
      pass: score >= 0.5,
      score,
    });
    const def = defineEval({
      async test(t) {
        await t.send("q");
        t.check(t.reply, scored(0.2)).atLeast(0.5); // gate, below threshold
      },
    });
    const result = await runEval(def, {
      id: "gate",
      driver: fakeDriver({ reply: "x" }),
    });
    expect(result.passed).toBe(false);
    expect(result.assertions[0].severity).toBe("gate");
  });

  test("atLeast().soft() demotes so a below-threshold score only tracks", async () => {
    const scored = (score: number) => (): { pass: boolean; score: number } => ({
      pass: score >= 0.5,
      score,
    });
    const def = defineEval({
      async test(t) {
        await t.send("q");
        t.check(t.reply, scored(0.2)).atLeast(0.5).soft();
      },
    });
    const result = await runEval(def, {
      id: "soft-judge",
      driver: fakeDriver({ reply: "x" }),
    });
    expect(result.passed).toBe(true);
    expect(result.assertions[0].severity).toBe("soft");
    expect(result.assertions[0].pass).toBe(false);
  });

  test("t.reset() forwards to the driver to start a fresh conversation", async () => {
    const reset = vi.fn();
    const driver: EvalDriver = {
      send: async () => ({
        reply: "",
        toolCalls: [],
        toolCallDetails: [],
        succeeded: true,
      }),
      reset,
    };
    const def = defineEval({
      async test(t) {
        await t.send("first");
        t.reset();
        await t.send("second");
      },
    });
    await runEval(def, { id: "reset", driver });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("t.reset() is a no-op when the driver has no reset", async () => {
    const def = defineEval({
      async test(t) {
        t.reset();
        await t.send("hi");
      },
    });
    // fakeDriver has no reset(); this must not throw.
    const result = await runEval(def, {
      id: "no-reset",
      driver: fakeDriver({}),
    });
    expect(result.passed).toBe(true);
  });

  test("def.timeoutMs turns a hanging test into a non-passing timeout result", async () => {
    const def = defineEval({
      timeoutMs: 20,
      async test() {
        // Never resolves; only the timeout can settle the eval.
        await new Promise<void>(() => {});
      },
    });
    const result = await runEval(def, { id: "hang", driver: fakeDriver({}) });
    expect(result.passed).toBe(false);
    expect(result.error).toBe("eval timed out after 20ms");
  });

  test("a fast eval passes well under the same timeout", async () => {
    const def = defineEval({
      timeoutMs: 20,
      async test(t) {
        await t.send("hi");
        t.succeeded();
      },
    });
    const result = await runEval(def, {
      id: "fast",
      driver: fakeDriver({ succeeded: true }),
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("RunEvalOptions.timeoutMs applies when the def has none", async () => {
    const def = defineEval({
      async test() {
        await new Promise<void>(() => {});
      },
    });
    const result = await runEval(def, {
      id: "runner-timeout",
      driver: fakeDriver({}),
      timeoutMs: 20,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe("eval timed out after 20ms");
  });

  test("def.timeoutMs overrides the runner-level default", async () => {
    const def = defineEval({
      timeoutMs: 15,
      async test() {
        await new Promise<void>(() => {});
      },
    });
    const result = await runEval(def, {
      id: "per-eval-wins",
      driver: fakeDriver({}),
      timeoutMs: 5000,
    });
    expect(result.error).toBe("eval timed out after 15ms");
  });
});
