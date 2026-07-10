import {
  defineEval,
  isJudgeConfigured,
  userTurns,
} from "@databricks/appkit/beta";

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
 *
 * A row's `messages` can be a full multi-turn conversation. We replay each USER
 * turn in order against one shared thread (below); interleaved assistant turns
 * in the row are ignored — the agent generates its own responses.
 */

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
    // Replay every user turn in the row against one thread, so the agent sees
    // the accumulating conversation. A single-user-turn row sends once. The
    // runner gives each row a fresh driver, so rows don't bleed into each other.
    for (const turn of userTurns(t.input)) {
      await t.send(turn);
    }
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
