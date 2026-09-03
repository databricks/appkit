import type { AgentAdapter, AgentInput } from "shared";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { StructuredOutputError } from "../../../errors";
import { createAgent } from "../create-agent";
import { runAgent } from "../run-agent";
import { tool } from "../tools/tool";

const schema = z.object({ answer: z.string(), score: z.number() });

/** Fake adapter that records each run() input and emits a scripted text per call. */
function recordingAdapter(
  texts: string[],
): AgentAdapter & { calls: AgentInput[] } {
  const calls: AgentInput[] = [];
  let i = 0;
  return {
    calls,
    async *run(input) {
      calls.push(input);
      const text = texts[Math.min(i, texts.length - 1)];
      i++;
      yield { type: "status", status: "running" };
      yield { type: "message_delta", content: text };
    },
  };
}

describe("runAgent structured output", () => {
  test("tool-free agent: output is parsed; main run carries outputSchema, no tools", async () => {
    const adapter = recordingAdapter(['{"answer":"hi","score":1}']);
    const agent = createAgent({
      instructions: "classify",
      model: adapter,
      output: schema,
    });

    const result = await runAgent(agent, { messages: "hello" });

    expect(result.output).toEqual({ answer: "hi", score: 1 });
    // Statically typed via z.infer — this line only compiles if the type is right.
    const typed: { answer: string; score: number } | undefined = result.output;
    expect(typed?.answer).toBe("hi");

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].outputSchema).toBeDefined();
    expect(adapter.calls[0].tools).toEqual([]);
  });

  test("tool-having agent: runs a tool-free structuring pass over the prose answer", async () => {
    const adapter = recordingAdapter([
      "The answer is hi with a score of 1.", // main run: prose
      '{"answer":"hi","score":1}', // structuring pass: JSON
    ]);
    const agent = createAgent({
      instructions: "classify",
      model: adapter,
      output: schema,
      tools: {
        noop: tool({
          name: "noop",
          description: "does nothing",
          schema: z.object({}),
          execute: () => "ok",
        }),
      },
    });

    const result = await runAgent(agent, { messages: "hello" });

    expect(result.output).toEqual({ answer: "hi", score: 1 });
    expect(adapter.calls).toHaveLength(2);
    // Main run exposed the tool; the structuring pass is tool-free + constrained.
    expect(adapter.calls[0].tools).toHaveLength(1);
    expect(adapter.calls[1].tools).toEqual([]);
    expect(adapter.calls[1].outputSchema).toBeDefined();
  });

  test("per-call { output } override drives structured output when the agent has none", async () => {
    const adapter = recordingAdapter(['{"answer":"o","score":2}']);
    const agent = createAgent({ instructions: "x", model: adapter });

    const result = await runAgent(
      agent,
      { messages: "hi" },
      { output: schema },
    );

    expect(result.output).toEqual({ answer: "o", score: 2 });
  });

  test("throws StructuredOutputError when output never validates", async () => {
    const adapter = recordingAdapter(["not json at all"]);
    const agent = createAgent({
      instructions: "x",
      model: adapter,
      output: schema,
    });

    await expect(runAgent(agent, { messages: "hi" })).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
    // 1 main run + 2 structuring retries.
    expect(adapter.calls).toHaveLength(3);
  });

  test("no output schema: result.output is undefined, no extra runs", async () => {
    const adapter = recordingAdapter(["just some prose"]);
    const agent = createAgent({ instructions: "x", model: adapter });

    const result = await runAgent(agent, { messages: "hi" });

    expect(result.output).toBeUndefined();
    expect(result.text).toBe("just some prose");
    expect(adapter.calls).toHaveLength(1);
  });
});
