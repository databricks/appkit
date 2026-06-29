import { defineEval } from "@databricks/appkit/beta";

/**
 * LLM-as-judge eval: scores the helper agent's weather answer with a judge
 * model (via autoevals → a Databricks serving endpoint).
 *
 * Requires a judge model:
 *   appkit agent eval query --root apps/dev-playground --url http://localhost:8001 \
 *     --judge-model databricks-claude-sonnet-4-5
 * (or set APPKIT_JUDGE_MODEL). Without it, t.judge.* errors with a clear message.
 */
export default defineEval({
  description: "Helper weather answer is relevant (LLM judge)",
  agent: "helper",
  async test(t) {
    await t.send("What's the weather in Brooklyn?");
    t.succeeded();
    // closedQA needs no ground truth — it judges the reply against a question.
    (
      await t.judge.closedQA(
        "Does the response describe weather conditions for Brooklyn?",
      )
    ).atLeast(0.5);
  },
});
