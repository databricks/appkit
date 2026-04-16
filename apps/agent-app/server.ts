import {
  analytics,
  createAgent,
  files,
  mcpServer,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

const port = Number(process.env.DATABRICKS_APP_PORT) || 8003;

createAgent({
  plugins: [analytics(), files()],
  tools: [
    tool({
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({
        city: z.string().describe("City name"),
      }),
      execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
    }),
    mcpServer(
      "mario-mcp-hello",
      "https://mario-mcp-hello-6051921418418893.staging.aws.databricksapps.com/mcp",
    ),
    mcpServer(
      "vector-search",
      "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/vector-search/main/default",
    ),
    mcpServer(
      "uc-greet",
      "https://e2-dogfood.staging.cloud.databricks.com/api/2.0/mcp/functions/main/mario/greet",
    ),
  ],
  port,
}).then((agent) => {
  console.log(
    `Agent running on port ${port} with ${agent.getTools().length} tools`,
  );
});
