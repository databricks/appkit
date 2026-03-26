import { analytics, createAgent, files } from "@databricks/appkit";
import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const endpointName =
  process.env.DATABRICKS_AGENT_ENDPOINT ?? "databricks-claude-sonnet-4-5";

createAgent({
  plugins: [analytics(), files()],
  adapter: DatabricksAdapter.fromServingEndpoint({
    workspaceClient: new WorkspaceClient({}),
    endpointName,
    systemPrompt:
      "You are a helpful data assistant. Use the available tools to query data and help users with their analysis.",
  }),
  port: 8003,
}).then((agent) => {
  const tools = agent.getTools();
  console.log(`Agent running with ${tools.length} tools`);
  console.log("Tools:", tools.map((t) => t.name).join(", "));
});
