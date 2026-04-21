import { analytics, createAgent, files } from "@databricks/appkit";

createAgent({
  agents: {
    assistant: {
      // Provide an agent-capable model or any custom serving endpoint
      model: "databricks-claude-sonnet-4-5",
      // Provide plugins, auto-translated to tools
      plugins: [analytics(), files()],
      // User can also provide Supervisor API-compatible tools manually.
      // If user provides a non-Supervisor API-compatible tool while attempting to use a model with Databricks-enabled agent, we'll display a warning
      tools: [
        {
          type: "genie_space",
          genie_space: { id: "ID", description: "Description" },
        },
        {
          type: "uc_function",
          uc_function: { name: "cat.sch.fn", description: "Description" },
        },
      ],
      port: 8003,
    },
  },
});
