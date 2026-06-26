import { defineEval, includes } from "@databricks/appkit/beta";

export default defineEval({
  description: "Helper agent smoke test",
  // Target the default code-defined agent. Drop this to use the `query` agent
  // (the parent directory name).
  agent: "helper",
  async test(t) {
    await t.send("What is 2 + 2?");
    t.succeeded(); // gate: the turn completed
    t.check(t.reply, includes("4")).soft(); // tracked metric, won't fail the gate
  },
});
