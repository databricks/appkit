import { createAgent } from "@databricks/appkit/beta";
import { z } from "zod";

// Structured-output demo: a tool-free agent whose answer is validated against
// its `output` Zod schema instead of returned as text. Discovered from the
// folder name (`classifier`). See docs/plugins/agents.md "Structured output"
// for how the object surfaces on /chat, /invocations, and in-process runAgent.
export default createAgent({
  instructions:
    "You are a support-ticket triage classifier. Read the user's message and " +
    "classify it into one category, decide whether it is urgent (the user is " +
    "blocked or reports an outage), and write a one-sentence summary.",
  output: z.object({
    category: z
      .enum(["billing", "bug", "feature_request", "how_to", "other"])
      .describe("The single best-fit category for the ticket."),
    urgent: z
      .boolean()
      .describe("True only if the user is blocked or reports an outage."),
    summary: z.string().describe("A one-sentence summary of the request."),
  }),
});
