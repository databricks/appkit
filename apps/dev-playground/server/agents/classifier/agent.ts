import { createAgent } from "@databricks/appkit/beta";
import { z } from "zod";

// Structured-output demo: a tool-free agent whose final answer is validated
// against a Zod schema instead of being returned as freeform text. Discovered
// automatically from server/agents/classifier/ (its id is the folder name,
// "classifier").
//
// How the schema surfaces on each path:
//   • POST /api/agents/chat with { message, agent: "classifier" } streams the
//     text, then emits one final `appkit.structured_output` SSE event whose
//     `data` is the parsed object.
//   • POST /api/agents/invocations (when this is the default agent) returns a
//     top-level `output_parsed` field alongside the usual `output` text.
//   • In-process, the result is statically typed via z.infer:
//       import { runAgent } from "@databricks/appkit/beta";
//       const { output } = await runAgent(classifier, { messages: ticket });
//       output?.category; // "billing" | "bug" | ... | undefined
//
// The agent answers normally, then AppKit runs a dedicated non-streaming
// completion constrained by the schema (Databricks rejects `response_format`
// under streaming) and validates it with Zod before surfacing the object.
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
