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
  test("validates the answer as-is when it is already valid JSON (no pass)", async () => {
    const pass = vi.fn<StructuringPass>();
    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: JSON.stringify({ category: "billing", urgent: true }),
      runStructuringPass: pass,
    });

    expect(output).toEqual({ category: "billing", urgent: true });
    expect(pass).not.toHaveBeenCalled();
  });

  test("reformats a prose answer via one structuring pass", async () => {
    const pass = vi
      .fn<StructuringPass>()
      .mockResolvedValue(JSON.stringify({ category: "sales", urgent: false }));

    const output = await resolveStructuredOutput({
      schema,
      baseMessages: baseMessages(),
      finalText: "This looks like a sales question, not urgent.",
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
      finalText: JSON.stringify({ category: "billing" }), // invalid — triggers a pass
      runStructuringPass: pass,
    });

    expect(output).toEqual({ category: "billing", urgent: true });
    // pass #1 (convert) invalid -> pass #2 (retry w/ errors) valid.
    expect(pass).toHaveBeenCalledTimes(2);
    // The FIRST pass is the convert instruction; the retry carries the zod error.
    expect(pass.mock.calls[0][0].at(-1)?.content).toMatch(
      /JSON matching the provided schema/i,
    );
    const retryMsg = pass.mock.calls[1][0].at(-1)?.content ?? "";
    expect(retryMsg).toMatch(/did not match the required schema/i);
    expect(retryMsg).toMatch(/urgent/);
  });

  test("throws StructuredOutputError with lastRaw after retries exhausted", async () => {
    const pass = vi.fn<StructuringPass>().mockResolvedValue("still not json");

    await expect(
      resolveStructuredOutput({
        schema,
        baseMessages: baseMessages(),
        finalText: "not json either",
        runStructuringPass: pass,
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputError",
      lastRaw: "still not json",
    });

    // convert pass + 2 retry passes = 3 structuring attempts.
    expect(pass).toHaveBeenCalledTimes(3);
  });

  test("StructuredOutputError does not leak lastRaw via clientMessage", () => {
    const err = new StructuredOutputError("boom", { lastRaw: "secret raw" });
    expect(err.clientMessage).not.toContain("secret raw");
  });
});
