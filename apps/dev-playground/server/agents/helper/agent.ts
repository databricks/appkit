import { createAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

// Code-defined demo agent showing the tools(plugins) function form alongside
// the markdown-driven agents. Discovered automatically from
// server/agents/helper/ — its id is the folder name ("helper").
export default createAgent({
  instructions:
    "You are a demo helper. Use analytics tools to answer data questions, " +
    "or get_weather for light small-talk.",
  // Opts into the global `haiku` skill (server/agents/skills/haiku/SKILL.md).
  // The model auto-loads it when a request matches, or the user can force it
  // with `/haiku …` in the chat box.
  skills: ["haiku"],
  tools(plugins) {
    return {
      ...plugins.analytics.toolkit(),
      get_weather: tool({
        name: "get_weather",
        description: "Get the current weather for a city",
        schema: z.object({ city: z.string().describe("City name") }),
        execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
      }),
    };
  },
});
