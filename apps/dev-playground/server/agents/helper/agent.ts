import { createAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

// Code-defined demo agent showing the tools(plugins) function form alongside
// the markdown-driven agents. Discovered automatically from
// server/agents/helper/ — its id is the folder name ("helper").
export default createAgent({
  instructions:
    "You are a demo helper. Use analytics tools to answer data questions, " +
    "or get_weather for light small-talk.",
  // Opts into two global skills (server/agents/skills/<name>/SKILL.md). A code
  // agent has no per-agent skills/ folder, so opting in is the only way it
  // reaches the shared pool. The model auto-loads a skill when a request
  // matches, or the user can force one with `/haiku …` / `/bullet-brief …`.
  skills: ["haiku", "bullet-brief"],
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
