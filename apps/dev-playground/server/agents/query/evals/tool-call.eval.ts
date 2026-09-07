import { defineEval } from "@databricks/appkit/beta";

/**
 * Tool-call eval: the default `helper` agent should call its `get_weather`
 * tool when asked about the weather. (Targets `helper` explicitly — the parent
 * directory only determines discovery, not which agent runs.)
 */
export default defineEval({
  description: "Helper agent calls the get_weather tool",
  agent: "helper",
  async test(t) {
    await t.send("What's the weather in Brooklyn?");
    t.succeeded();
    t.calledTool("get_weather");
  },
});
