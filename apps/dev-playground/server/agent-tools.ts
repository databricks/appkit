import type { FunctionTool } from "@databricks/appkit";

export const weatherTool: FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name, e.g. 'San Francisco'",
      },
    },
    required: ["location"],
  },
  execute: async ({ location }) => {
    const conditions = ["sunny", "partly cloudy", "rainy", "windy"];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = Math.floor(Math.random() * 30) + 50;
    return `Weather in ${location}: ${condition}, ${temp}°F`;
  },
};

export const timeTool: FunctionTool = {
  type: "function",
  name: "get_current_time",
  description: "Get the current date and time in a timezone",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, e.g. 'America/New_York'. Defaults to UTC",
      },
    },
  },
  execute: async ({ timezone }) => {
    const tz = (timezone as string) ?? "UTC";
    return `Current time in ${tz}: ${new Date().toLocaleString("en-US", { timeZone: tz })}`;
  },
};

export const demoTools = { weatherTool, timeTool };
