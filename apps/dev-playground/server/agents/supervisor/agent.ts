import {
  createAgent,
  DatabricksAdapter,
  supervisorTools,
} from "@databricks/appkit/beta";

// Supervisor API demo agent. The Databricks AI Gateway executes hosted
// tools server-side; declare them via `createAgent({ tools })` like any
// other agent tool — the agents plugin classifies the tagged record and
// routes it to the adapter via AgentInput.extensions. Uncomment an entry
// below to give the model real powers.
//
// `createAgent({ model })` accepts an adapter promise, so the factory's
// host/credential resolution is awaited lazily on first dispatch (via
// `resolveAdapter` in the agents plugin). A misconfigured workspace will
// surface at first chat request, not at module init.
export default createAgent({
  instructions:
    "You are an assistant powered by the Databricks Supervisor API.",
  model: DatabricksAdapter.fromSupervisorApi({
    model: "databricks-claude-sonnet-4-5",
  }),
  tools: () => ({
    nyc: supervisorTools.genieSpace({
      id: process.env.DATABRICKS_GENIE_SPACE_ID ?? "",
      description: "NYC taxi trip records and zones",
    }),
    add: supervisorTools.ucFunction({
      name: process.env.DATABRICKS_UC_FUNCTION_NAME ?? "",
      description: "Adds two integers and returns the sum.",
    }),
  }),
});
