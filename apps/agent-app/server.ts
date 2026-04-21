import {
  agents,
  analytics,
  createAgent,
  createApp,
  files,
  fromPlugin,
  mcpServer,
  server,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

const port = Number(process.env.DATABRICKS_APP_PORT) || 8003;

// Shared tool available to any agent that declares `tools: [get_weather]` in
// its markdown frontmatter.
const get_weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({
    city: z.string().describe("City name"),
  }),
  execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
});

// Code-defined agent. Overrides config/agents/support.md if a file with that
// name exists. Tools here are explicit; defaults are strict (no auto-inherit
// for code-defined agents), so we pull analytics + files in via fromPlugin.
const support = createAgent({
  instructions:
    "You help customers with data analysis, file browsing, and general questions. " +
    "Use the available tools as needed and summarize results concisely.",
  tools: {
    ...fromPlugin(analytics),
    ...fromPlugin(files),
    get_weather,
    "mcp.vector-search": mcpServer(
      "vector-search",
      "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/vector-search/main/default",
    ),
    "mcp.uc-greet": mcpServer(
      "uc-greet",
      "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/functions/main/mario/greet",
    ),
    "mcp.mario-hello": mcpServer(
      "mario-mcp-hello",
      "https://mario-mcp-hello-6051921418418893.staging.aws.databricksapps.com/mcp",
    ),
  },
});

const appkit = await createApp({
  plugins: [
    server({ port }),
    analytics(),
    files(),
    agents({
      // Ambient tool library referenced by markdown frontmatter `tools: [...]`.
      tools: { get_weather },
      // Code-defined agents are merged with markdown agents; code wins on key
      // collision. Markdown agents still auto-inherit analytics+files tools
      // unless their frontmatter says otherwise.
      agents: { support },
    }),
  ],
});

const registry = appkit.agent as {
  list: () => string[];
  getDefault: () => string | null;
};
console.log(
  `Agent app running on port ${port}. Agents: ${registry.list().join(", ")}. Default: ${registry.getDefault() ?? "(none)"}.`,
);
