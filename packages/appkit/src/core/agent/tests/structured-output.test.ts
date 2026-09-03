import type { Message } from "shared";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { StructuredOutputError } from "../../../errors";
import {
  resolveStructuredOutput,
  type StructuringPass,
} from "../structured-output";

const schema = z.object({ category: z.string(), urgent: z.boolean() });

function baseMessages(): Message[] {
  return [
    { id: "s", role: "system", content: "classify", createdAt: new Date() },
    { id: "u", role: "user", content: "help me", createdAt: new Date() },
  ];
}

describe("resolveStructuredOutput", () => {
  test("tool-free: validates finalText directly, no structuring pass", async () => {
    const pass = vi.fn<StructuringPass>();
    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: JSON.stringify({ category: "billing", urgent: true }),
      hadTools: false,
      runStructuringPass: pass,
    });

    expect(output).toEqual({ category: "billing", urgent: true });
    expect(pass).not.toHaveBeenCalled();
  });

  test("tool-having: runs one structuring pass over the answer", async () => {
    const pass = vi
      .fn<StructuringPass>()
      .mockResolvedValue(JSON.stringify({ category: "sales", urgent: false }));

    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: "This looks like a sales question, not urgent.",
      hadTools: true,
      runStructuringPass: pass,
    });

    expect(output).toEqual({ category: "sales", urgent: false });
    expect(pass).toHaveBeenCalledTimes(1);
    // The prose answer is appended as an assistant turn + a convert instruction.
    const [msgs] = pass.mock.calls[0];
    expect(msgs.at(-2)).toMatchObject({ role: "assistant" });
    expect(msgs.at(-1)?.role).toBe("user");
    expect(msgs.at(-1)?.content).toMatch(/JSON matching the provided schema/i);
  });

  test("strips code fences before parsing", async () => {
    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: '```json\n{"category":"support","urgent":false}\n```',
      hadTools: false,
      runStructuringPass: vi.fn<StructuringPass>(),
    });
    expect(output).toEqual({ category: "support", urgent: false });
  });

  test("re-prompts with zod errors on validation failure, then succeeds", async () => {
    const pass = vi
      .fn<StructuringPass>()
      .mockResolvedValueOnce(JSON.stringify({ category: "billing" })) // missing urgent
      .mockResolvedValueOnce(
        JSON.stringify({ category: "billing", urgent: true }),
      );

    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: JSON.stringify({ category: "billing" }), // invalid attempt 0
      hadTools: false,
      runStructuringPass: pass,
    });

    expect(output).toEqual({ category: "billing", urgent: true });
    // attempt 0 = finalText (invalid) -> retry 1 (invalid) -> retry 2 (valid)
    expect(pass).toHaveBeenCalledTimes(2);
    // The retry carries the flattened zod error text.
    const [retryMsgs] = pass.mock.calls[0];
    expect(retryMsgs.at(-1)?.content).toMatch(
      /did not match the required schema/i,
    );
    expect(retryMsgs.at(-1)?.content).toMatch(/urgent/);
  });

  test("throws StructuredOutputError with lastRaw after retries exhausted", async () => {
    const pass = vi.fn<StructuringPass>().mockResolvedValue("still not json");

    await expect(
      resolveStructuredOutput({
        schema,
        baseMessages: baseMessages(),
        finalText: "not json either",
        hadTools: false,
        runStructuringPass: pass,
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputError",
      lastRaw: "still not json",
    });

    // attempt 0 (finalText) + 2 retries = 2 structuring passes.
    expect(pass).toHaveBeenCalledTimes(2);
  });

  test("StructuredOutputError does not leak lastRaw via clientMessage", () => {
    const err = new StructuredOutputError("boom", { lastRaw: "secret raw" });
    expect(err.clientMessage).not.toContain("secret raw");
  });
});
