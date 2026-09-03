import { describe, expect, test } from "vitest";

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
});
