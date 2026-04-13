import { analytics, createAgent, files } from "@databricks/appkit";
import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const endpointName =
  process.env.DATABRICKS_AGENT_ENDPOINT ?? "databricks-claude-sonnet-4-5";
const port = Number(process.env.DATABRICKS_APP_PORT) || 8003;

createAgent({
  plugins: [analytics(), files()],
  adapter: DatabricksAdapter.fromServingEndpoint({
    workspaceClient: new WorkspaceClient({}),
    endpointName,
    systemPrompt: [
      "You are a helpful data assistant running on Databricks.",
      "Use the available tools to query data, browse files, and help users with their analysis.",
      "When using analytics.query, write Databricks SQL.",
      "When results are large, summarize the key findings rather than dumping raw data.",
    ].join(" "),
  }),
  port,
}).then((agent) => {
  const tools = agent.getTools();
  console.log(`Agent running on port ${port} with ${tools.length} tools`);
  console.log("Tools:", tools.map((t) => t.name).join(", "));
});
