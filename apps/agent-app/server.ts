import {
  agents,
  analytics,
  createAgent,
  createApp,
  files,
  mcpServer,
  server,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

const port = Number(process.env.DATABRICKS_APP_PORT) || 8003;

// Ambient function tool. Referenced from `config/agents/support/agent.md` under
// `tools: [get_weather]`. Markdown frontmatter looks up this name against
// the `tools:` record passed to `agents({ tools: { get_weather } })` below.
const get_weather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({
    city: z.string().describe("City name"),
  }),
  execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
});

// MCP servers are conditional on runtime env vars — something markdown
// frontmatter can't express. This is the motivating case for defining
// the `researcher` agent in code below: it wires whatever MCP tools are
// configured at boot, and is always callable (with a graceful fallback
// when nothing is wired).
//
// Any MCP URL configured here must also be allowlisted via
// `agents({ mcp: { trustedHosts: [...] } })` before outbound calls will
// be allowed by the zero-trust host policy.
const customMcpServers: Record<string, ReturnType<typeof mcpServer>> = {};
if (process.env.VECTOR_SEARCH_MCP_URL) {
  customMcpServers["mcp.vector-search"] = mcpServer(
    "vector-search",
    process.env.VECTOR_SEARCH_MCP_URL,
  );
}
if (process.env.CUSTOM_MCP_URL) {
  customMcpServers["mcp.custom"] = mcpServer(
    "custom",
    process.env.CUSTOM_MCP_URL,
  );
}

// Code-defined research specialist. `assistant.md` references this by name
// under `agents: [researcher]`; the agents plugin resolves that reference
// against both markdown siblings and code-defined agents, with code winning
// on collision. Defined in code so its MCP toolset can flex on env vars.
const researcher = createAgent({
  instructions:
    "You are a research specialist. When MCP tools are available " +
    "(vector search, custom endpoints), prefer them for knowledge lookups. " +
    "If no MCP tools are configured, say so briefly and answer from general " +
    "knowledge. Always include your source or note when you're answering " +
    "without search.",
  tools: {
    get_weather,
    ...customMcpServers,
  },
});

const trustedMcpHosts = [
  process.env.VECTOR_SEARCH_MCP_URL,
  process.env.CUSTOM_MCP_URL,
]
  .filter((u): u is string => typeof u === "string" && u.length > 0)
  .map((u) => new URL(u).hostname);

const appkit = await createApp({
  plugins: [
    server({ port }),
    analytics(),
    files(),
    agents({
      // Code-defined agents merged with markdown agents; code wins on name
      // collision. Markdown `agents: [...]` frontmatter can reference either.
      agents: { researcher },
      // Ambient tool library for markdown agents referencing names under
      // their `tools:` frontmatter.
      tools: { get_weather, ...customMcpServers },
      // Enables auto-inherit of read-only plugin tools (analytics/files) into
      // markdown agents that declare no explicit `toolkits:` / `tools:`. Both
      // assistant.md and support.md are explicit, so this is a no-op today,
      // but kept as a knob markdown authors can rely on.
      autoInheritTools: { file: true },
      mcp: { trustedHosts: trustedMcpHosts },
    }),
  ],
});

console.log(
  `Agent app running on port ${port}. ` +
    `Agents: ${appkit.agents.list().join(", ") || "(none)"}. ` +
    `Default: ${appkit.agents.getDefault() ?? "(none)"}.`,
);
