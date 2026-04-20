# Migrating to the `agents()` plugin

The old `createAgent({ adapter, port, tools, plugins })` shortcut from the agent PR stack is deprecated. The new shape splits agent *definition* (pure data) from app *composition* (plugin registration).

The old exports still work — they're kept side-by-side until a future removal release. This guide shows how to port code incrementally.

## Name changes at a glance

| Old | New |
|---|---|
| `createAgent(config)` (app shortcut) | `createAgentApp(config)` (deprecated) |
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

Plugin toolkits (`ToolkitEntry` from `.toolkit()`) require `createApp`; `runAgent` throws a clear error if invoked with one.

## Gradual migration

Both APIs coexist. You can land the dependency bump today, keep using `createAgentApp` (the renamed old shortcut), and migrate call sites one at a time:

```ts
import { createAgentApp, analytics, tool } from "@databricks/appkit";

// Old shape still works, just renamed:
createAgentApp({ plugins: [analytics()], tools: [/* ... */] });
```

When you're ready, switch the import to `createApp({ plugins: [..., agents()] })` and remove the `createAgentApp` call. No other code needs to change.

## Removal timeline

The old `agent()` and `createAgentApp` exports remain until feedback on the new shape stabilizes. A follow-up PR will remove them in a future release; use of the deprecated exports surfaces via IDE strikethrough (JSDoc `@deprecated`) but does not log runtime warnings.
