import { defineEval } from "@databricks/appkit/beta";

/**
 * Example eval. The agent defaults to this directory's name (`query`).
 * Run with:
 *   pnpm exec appkit agent eval query --root apps/dev-playground --url http://localhost:8000
 */
export default defineEval({
  description: "Query dispatcher responds to a greeting",
  async test(t) {
    await t.send("Hi there!");
    t.succeeded(); // gate: the turn completed
  },
});
