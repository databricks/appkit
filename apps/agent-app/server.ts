import { analytics, createAgent, files } from "@databricks/appkit";
import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";
import { WorkspaceClient } from "@databricks/sdk-experimental";

const endpointName =
  process.env.DATABRICKS_AGENT_ENDPOINT ?? "databricks-claude-sonnet-4-5";
const port = Number(process.env.DATABRICKS_APP_PORT) || 8003;

createAgent({
  plugins: [analytics(), files()],
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
      execute: async ({ city }) => {
        return `The weather in ${city} is sunny, 22°C`;
      },
    },
    {
      type: "custom_mcp_server",
      custom_mcp_server: {
        app_name: "mario-mcp-hello",
        app_url:
          "https://mario-mcp-hello-6051921418418893.staging.aws.databricksapps.com/mcp",
      },
    },
    {
      type: "custom_mcp_server",
      custom_mcp_server: {
        app_name: "vector-search",
        app_url:
          "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/vector-search/main/default",
      },
    },
    {
      type: "custom_mcp_server",
      custom_mcp_server: {
        app_name: "uc-greet",
        app_url:
          "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/functions/main/mario/greet",
      },
    },
  ],
  adapter: DatabricksAdapter.fromServingEndpoint({
    workspaceClient: new WorkspaceClient({}),
    endpointName,
    systemPrompt: [
      "You are a helpful data assistant running on Databricks.",
      "Use the available tools to query data, browse files, and help users with their analysis.",
      "When using analytics.query, write Databricks SQL.",
      "When results are large, summarize the key findings rather than dumping raw data.",
      "You also have access to additional tools from MCP servers — use them when relevant.",
    ].join(" "),
  }),
  port,
}).then((agent) => {
  console.log(
    `Agent running on port ${port} with ${agent.getTools().length} tools`,
  );
});
