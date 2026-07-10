import { defineEval, isJudgeConfigured } from "@databricks/appkit/beta";

/**
 * Dataset-driven eval: runs once per row of a Databricks managed evaluation
 * dataset (a Unity Catalog table with `inputs`/`expectations` columns). The
 * runner binds each row to `t.input`/`t.expected`.
 *
 * Run it (reading the dataset needs a workspace client + warehouse; judging the
 * guidelines needs a judge model):
 *   appkit agent eval dataset --root apps/dev-playground --url http://localhost:8000 \
 *     --profile <profile> --warehouse <warehouse-id> --judge-model <endpoint>
 *
 * Row shape produced by the MLflow managed-dataset UI:
 *   inputs        {"messages":[{"role":"user","content":"..."}]}
 *   expectations  {"guidelines":{"value":["...","..."]}}   (optional)
 */

/** Pull the last user message out of an MLflow `{messages:[...]}` input. */
function userMessage(input: Record<string, unknown>): string {
  const messages = Array.isArray(input.messages)
    ? (input.messages as Array<{ role?: string; content?: string }>)
    : [];
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content ?? "";
}

/** Read `expectations.guidelines` — the UI wraps the array as `{value: [...]}`. */
function guidelines(expected: Record<string, unknown> | undefined): string[] {
  const g = (expected?.guidelines as { value?: unknown } | undefined)?.value;
  return Array.isArray(g) ? g.map(String) : [];
}

export default defineEval({
  description: "Query agent satisfies each dataset row's guidelines",
  // Point at your own managed evaluation dataset (catalog.schema.table).
  dataset: { table: "main.mario.appkit_eval_dataset" },
  async test(t) {
    // One turn per row. For a multi-turn conversation, call `t.send` again
    // (same thread); to start an independent turn in the same test, `t.reset()`.
    await t.send(userMessage(t.input));
    t.succeeded();

    // Each guideline is judged against the reply — gate by default, so a miss
    // fails the eval (chain `.soft()` to only track it). Skipped cleanly when no
    // judge model is configured, so the eval still exercises the dataset read +
    // drive path without one.
    if (isJudgeConfigured()) {
      for (const guideline of guidelines(t.expected)) {
        (await t.judge.closedQA(guideline)).atLeast(0.5);
      }
    }
  },
});
