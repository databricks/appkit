import { expect, test } from "vitest";
import { z } from "zod";

import { inputErrorDetails } from "../operation-validation";

async function errors(schema: z.ZodType, value: unknown) {
  const result = await schema.safeParseAsync(value);
  if (result.success) throw new Error("Expected invalid fixture");
  return inputErrorDetails(schema)(result.error);
}

test("validation identifies declared nested fields and array indices", async () => {
  expect(
    await errors(
      z.object({
        notes: z.array(z.object({ content: z.string().trim().min(1) })),
      }),
      { notes: [{ content: " " }] },
    ),
  ).toEqual([
    { path: ["notes", "0", "content"], message: "Must not be empty" },
  ]);
});

test("nullable and union objects retain declared field paths", async () => {
  const schema = z.object({
    payload: z.object({ count: z.number().min(1) }).nullable(),
  });
  expect(await errors(schema, { payload: { count: 0 } })).toEqual([
    { path: ["payload", "count"], message: "Value is too small" },
  ]);
});

test("record keys, unknown keys, and custom messages cannot echo caller values", async () => {
  const secret = "caller-value-must-not-escape";
  const record = await errors(
    z.object({ values: z.record(z.string(), z.number()) }),
    { values: { [secret]: secret } },
  );
  expect(record).toEqual([{ path: ["values"], message: "Invalid value" }]);
  const strict = await errors(z.strictObject({ content: z.string() }), {
    content: "ok",
    [secret]: secret,
  });
  expect(strict).toEqual([
    { path: ["input"], message: "Contains unexpected fields" },
  ]);
  const custom = await errors(
    z.object({ content: z.string().refine(() => false, { error: secret }) }),
    { content: secret },
  );
  expect(custom).toEqual([{ path: ["content"], message: "Invalid value" }]);
  expect(JSON.stringify({ record, strict, custom })).not.toContain(secret);
});

test("custom issue paths cannot introduce undeclared names", async () => {
  const schema = z
    .object({ content: z.string() })
    .superRefine((_value, context) => {
      context.addIssue({
        code: "custom",
        path: ["caller-secret"],
        message: "caller-secret",
      });
    });
  expect(await errors(schema, { content: "hello" })).toEqual([
    { path: ["input"], message: "Invalid value" },
  ]);
});

test("validation detail output is bounded", async () => {
  const schema = z.object(
    Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`field${index}`, z.string()]),
    ),
  );
  expect(await errors(schema, {})).toHaveLength(20);
});
