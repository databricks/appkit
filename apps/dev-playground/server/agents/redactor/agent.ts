import { createAgent } from "@databricks/appkit/beta";

// Called from the DatabasePlugin's beforeCreate hook (server/database-hooks.ts)
// to show that a hook is server code and can reach any other plugin. Discovered
// automatically from server/agents/redactor/, so it is also registered as an
// agent — the hook drives it through runAgent(), not through those routes.
//
// Best-effort redaction; it is not a guarantee that all personal data is removed.
export default createAgent({
  instructions:
    "Replace every personal name and email address in the user's text with [redacted]. " +
    "Return only the rewritten text, nothing else.",
});
