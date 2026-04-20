# Agents

The `agents` plugin turns a Databricks AppKit app into an AI-agent host. It loads agent definitions from markdown files (convention: `config/agents/*.md`), from TypeScript (`createAgent(def)`), or both, and exposes them at `POST /invocations` alongside routes for chat, thread management, and cancellation.

This page covers the full lifecycle. For the hand-written primitives (`tool()`, `mcpServer()`), see [tools](./server.md).

## Install

`agents` is a regular plugin. Add it to `plugins[]` alongside `server()` and any ToolProvider plugins whose tools you want agents to reach.

```ts
import { agents, analytics, createApp, files, server } from "@databricks/appkit";

await createApp({
  plugins: [server(), analytics(), files(), agents()],
});
```

That alone gives you a live HTTP server with `POST /invocations` wired to a markdown-driven agent.

## Level 1: drop a markdown file

```
my-app/
  server.ts
  config/agents/
    assistant.md
```

```md
---
endpoint: databricks-claude-sonnet-4-5
default: true
---

You are a helpful data assistant running on Databricks.

Use the available tools to query data, browse files, and help users.
```

On startup the plugin:

1. Discovers the file at `./config/agents/assistant.md`.
2. Parses the YAML frontmatter and markdown body as the agent's `instructions`.
3. Resolves the adapter from `endpoint` (or falls back to `DATABRICKS_AGENT_ENDPOINT`).
4. Auto-inherits every registered ToolProvider plugin's tools (`analytics.*`, `files.*`, …).
5. Mounts the agent at the default name (`assistant`).

Requests land at `POST /invocations` with an OpenAI Responses-compatible body. Every tool call runs through `asUser(req)` so SQL executes as the requesting user, file access respects Unity Catalog ACLs, and telemetry spans are created automatically.

## Level 2: scope tools in frontmatter

```md
---
endpoint: databricks-claude-sonnet-4-5
toolkits:
  - analytics                             # all analytics.* tools
  - files: [uploads.read, uploads.list]   # only these files tools
  - genie: { except: [getConversation] }  # everything but getConversation
tools: [get_weather]                      # ambient tool declared in code
default: true
---

You are a read-only data analyst.
```

When any `toolkits:` or `tools:` is declared the auto-inherit default is turned off — the agent sees exactly the listed tools. Ambient tools (`tools: [get_weather]`) are looked up in the `agents({ tools: { ... } })` config.

## Level 3: code-defined agents

```ts
import {
  agents,
  analytics,
  createAgent,
  createApp,
  files,
  server,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

const analyticsP = analytics();
const filesP = files();

const support = createAgent({
  instructions: "You help customers with data and files.",
  model: "databricks-claude-sonnet-4-5",           // string sugar
  tools: {
    get_weather: tool({
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    }),
    ...analyticsP.toolkit(),                        // spread plugin tools
    ...filesP.toolkit({ only: ["uploads.read"] }),  // filtered
  },
});

await createApp({
  plugins: [server(), analyticsP, filesP, agents({ agents: { support } })],
});
```

Code-defined agents start with no tools by default. Spread `.toolkit()` outputs into `tools: { ... }` explicitly. The asymmetry (file: auto-inherit, code: strict) matches the personas: prompt authors want zero ceremony, engineers want no surprises.

## Level 4: sub-agents

```ts
const researcher = createAgent({
  instructions: "Research the question. Return concise bullets.",
  model: "databricks-claude-sonnet-4-5",
  tools: { search: tool({ /* ... */ }) },
});

const writer = createAgent({
  instructions: "Draft prose from notes.",
  model: "databricks-claude-sonnet-4-5",
});

const supervisor = createAgent({
  instructions: "Coordinate researcher and writer.",
  model: "databricks-claude-sonnet-4-5",
  agents: { researcher, writer },  // exposed as agent-researcher, agent-writer
});

await createApp({
  plugins: [
    server(),
    agents({ agents: { supervisor, researcher, writer } }),
  ],
});
```

Each key in `agents: {...}` on an `AgentDefinition` becomes an `agent-<key>` tool on the parent. When invoked, the agents plugin runs the child's adapter with a fresh message list (no shared thread state) and returns the aggregated text. Cycles are rejected at load time.

## Level 5: standalone (no `createApp`)

```ts
import { createAgent, runAgent, tool } from "@databricks/appkit";
import { z } from "zod";

const classifier = createAgent({
  instructions: "Classify tickets: billing | bug | feature.",
  model: "databricks-claude-sonnet-4-5",
  tools: {
    lookup_account: tool({ /* ... */ }),
  },
});

for (const ticket of tickets) {
  const result = await runAgent(classifier, {
    messages: [{ role: "user", content: ticket.body }],
  });
  await persistClassification(ticket.id, result.text);
}
```

`runAgent` drives the adapter without `createApp` or HTTP. Limitation: plugin toolkits (`ToolkitEntry`) require a live `PluginContext`, so they only work when invoked through `agents()` + `createApp`. Inline `tool()` and `mcpServer()` both work standalone.

## Configuration reference

```ts
agents({
  dir?: string | false,         // "./config/agents" default; false disables
  agents?: Record<string, AgentDefinition>,
  defaultAgent?: string,
  defaultModel?: AgentAdapter | Promise<AgentAdapter> | string,
  tools?: Record<string, AgentTool>,
  autoInheritTools?: boolean | { file?: boolean, code?: boolean },
  threadStore?: ThreadStore,    // default in-memory
  baseSystemPrompt?: false | string | (ctx: PromptContext) => string,
})
```

`autoInheritTools` defaults to `{ file: true, code: false }`. Boolean shorthand applies to both.

## Runtime API

After `createApp`, the plugin exposes:

```ts
appkit.agents.list();               // => ["support", "researcher", ...]
appkit.agents.get("support");       // => RegisteredAgent | null
appkit.agents.getDefault();         // => "support"
appkit.agents.register(name, def);  // dynamic registration
appkit.agents.reload();             // re-scan the directory
appkit.agents.getThreads(userId);   // list user's threads
```

## Frontmatter schema

| Key | Type | Notes |
|---|---|---|
| `endpoint` | string | Model serving endpoint name. Shortcut for `model`. |
| `model` | string | Same as `endpoint`; either works. |
| `toolkits` | array of string or `{ name: options }` | Spread plugin toolkits. Supports `only`, `except`, `rename`, `prefix`. |
| `tools` | array of string | Keys into `agents({ tools: {...} })`. |
| `default` | boolean | First file with `default: true` becomes the default agent. |
| `maxSteps` | number | Adapter max-step hint. |
| `maxTokens` | number | Adapter max-token hint. |
| `baseSystemPrompt` | false \| string | Per-agent override. `false` disables the AppKit base prompt. |

Unknown keys are logged and ignored. Invalid YAML and missing plugin/tool references throw at boot.

## Migration from the old API

See the [migration guide](../guides/migrating-to-agents-plugin.md).
