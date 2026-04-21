# Migrating to the `agents()` plugin

The old `createAgent({ adapter, port, tools, plugins })` shortcut has been removed. The new shape splits agent *definition* (pure data) from app *composition* (plugin registration).

## Name changes at a glance

| Old | New |
|---|---|
| `createAgent(config)` (app shortcut) | `createApp({ plugins: [..., agents()] })` |
| — | `createAgent(def)` (pure factory, **same name, new meaning**) |
| `agent()` plugin | `agents()` plugin (plural) |
| `tools: AgentTool[]` | `tools: Record<string, AgentTool>` |
| Auto-inherit all plugin tools | Asymmetric: markdown yes, code no |

## Before: old shortcut

```ts
import {
  analytics,
  createAgent,
  files,
  mcpServer,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

createAgent({
  plugins: [analytics(), files()],
  tools: [
    tool({
      name: "get_weather",
      description: "Weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    }),
    mcpServer("vector-search", "https://…/mcp/vector-search"),
  ],
  port: 8000,
}).then((agent) => {
  console.log(`Running with ${agent.getTools().length} tools`);
});
```

## After: createApp + agents()

```ts
import {
  agents,
  analytics,
  createApp,
  files,
  mcpServer,
  server,
  tool,
} from "@databricks/appkit";
import { z } from "zod";

const get_weather = tool({
  name: "get_weather",
  description: "Weather",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
    files(),
    agents({
      tools: {
        get_weather,
        "mcp.vector-search": mcpServer(
          "vector-search",
          "https://…/mcp/vector-search",
        ),
      },
    }),
  ],
});
```

Key differences:

- `plugins` moves to the top level of `createApp`; `agents()` goes into the plugin list.
- `server()` is explicit — required when you want HTTP.
- `tools` is a record on `agents({ tools })`, keyed by the tool-call name the LLM will see. Spread into agent definitions via markdown `tools: [get_weather]` or inline in `createAgent({ tools: { get_weather } })`.
- `port` moves to `server({ port })`.

## Frontmatter migration

The old parser was a flat key=value regex. The new parser is real YAML (`js-yaml`). Two things to watch for:

1. **Remove `##` markers**: `## default: true` was a Markdown heading that the old parser tolerated. YAML requires `default: true`.
2. **Validate structure**: previously typos were silently dropped; the new parser logs warnings for unknown keys and throws on truly invalid YAML.

Old:

```md
---
## default: true
## endpoint: databricks-claude-sonnet-4-5
---

You are helpful.
```

New:

```md
---
default: true
endpoint: databricks-claude-sonnet-4-5
---

You are helpful.
```

## Scoping tools in markdown

The new schema lets you declare tool scope right in the markdown file:

```md
---
endpoint: databricks-claude-sonnet-4-5
toolkits:
  - analytics
  - files: [uploads.read, uploads.list]
tools: [get_weather]
---

You are a read-only data assistant.
```

Engineers declare tools in code; prompt authors pick from a menu in frontmatter. No YAML-as-code ceremony required.

## Scoping tools in code with `fromPlugin`

Code-defined agents pull plugin tools in via `fromPlugin(factory, opts?)`. The marker is resolved against registered plugins at `agents()` setup time — you write each plugin factory twice (once inside `fromPlugin`, once in `plugins: [...]`), and nothing more.

```ts
import { agents, analytics, createAgent, createApp, files, fromPlugin, server } from "@databricks/appkit";

const support = createAgent({
  instructions: "…",
  tools: {
    ...fromPlugin(analytics),
    ...fromPlugin(files, { only: ["uploads.read"] }),
  },
});

await createApp({
  plugins: [server(), analytics(), files(), agents({ agents: { support } })],
});
```

`fromPlugin` accepts the same scoping options as markdown frontmatter toolkits (`only` / `except` / `prefix` / `rename`). If a referenced plugin isn't in `plugins: [...]`, `agents()` throws at setup with an `Available: …` listing.

## Standalone runs

The old `createAgent` returned a running HTTP app. Sometimes you want to run an agent in a script, cron, or test without HTTP. Use `runAgent`:

```ts
import { createAgent, runAgent, tool } from "@databricks/appkit";

const classifier = createAgent({
  instructions: "Classify tickets.",
  model: "databricks-claude-sonnet-4-5",
  tools: { /* inline tools only */ },
});

const result = await runAgent(classifier, { messages: "Billing issue please help" });
console.log(result.text);
```

To use plugin tools in standalone mode, pass the plugin factories through `plugins: [...]`. `runAgent` resolves any `fromPlugin` markers in the def against that list and dispatches tool calls as the service principal:

```ts
import { analytics, createAgent, fromPlugin, runAgent } from "@databricks/appkit";

const classifier = createAgent({
  instructions: "Classify tickets. Use analytics.query for historical data.",
  model: "databricks-claude-sonnet-4-5",
  tools: { ...fromPlugin(analytics) },
});

await runAgent(classifier, {
  messages: "is ticket 42 a duplicate?",
  plugins: [analytics()],
});
```

Hosted/MCP tools are still `agents()`-only (they need the live MCP client). Raw `ToolkitEntry` spreads from `.toolkit()` can't be dispatched standalone — `runAgent` throws a clear error pointing you at `fromPlugin`.
