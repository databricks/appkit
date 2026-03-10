import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const weatherTool = tool(
  async ({ location }) => {
    const conditions = ["sunny", "partly cloudy", "rainy", "windy"];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = Math.floor(Math.random() * 30) + 50;
    return `Weather in ${location}: ${condition}, ${temp}°F`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    schema: z.object({
      location: z.string().describe("City name, e.g. 'San Francisco'"),
    }),
  },
);

export const timeTool = tool(
  async ({ timezone }) => {
    const tz = timezone ?? "UTC";
    return `Current time in ${tz}: ${new Date().toLocaleString("en-US", { timeZone: tz })}`;
  },
  {
    name: "get_current_time",
    description: "Get the current date and time in a timezone",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. 'America/New_York'. Defaults to UTC"),
    }),
  },
);

export const demoTools = { weatherTool, timeTool };
