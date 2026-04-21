import { analytics, createAgent, files } from "@databricks/appkit";

createAgent({
  plugins: [analytics(), files()],
  model: "databricks-claude-sonnet-4-5",
  instructions: "You are a helpful data assistant...",
  tools: [
    {
      type: "genie_space",
      genie_space: {
        id: "01efb706dc1a1c068c3a3a561d08e843",
        description: "Answers data questions using SQL",
      },
    },
  ],
  port: 8003,
});
