# Function: createAgent()

```ts
function createAgent(config: CreateAgentConfig): Promise<AgentHandle>;
```

Creates an agent-powered app with batteries included.

Wraps `createApp` with `server()` and `agent()` pre-configured.
Automatically starts an HTTP server with agent chat routes.

Three flavors: single agent shorthand (`model`), multiple named agents (`agents`),
or a fully custom adapter (`adapter`). These are mutually exclusive.

For apps that need custom routes or manual server control,
use `createApp` with `server()` and `agent()` directly.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`CreateAgentConfig`](Interface.CreateAgentConfig.md) |

## Returns

`Promise`\<[`AgentHandle`](Interface.AgentHandle.md)\>

## Examples

```ts
// Single agent (shorthand)
import { createAgent, analytics } from "@databricks/appkit";

createAgent({
  plugins: [analytics()],
  model: "databricks-claude-sonnet-4-5",
  instructions: "You are a data assistant...",
  tools: [
    { type: "genie_space", genie_space: { id: "...", description: "..." } },
  ],
});
```

```ts
// Multiple agents
createAgent({
  plugins: [analytics(), files()],
  agents: {
    assistant: {
      model: "databricks-claude-sonnet-4-5",
      instructions: "You are a data assistant...",
    },
    helper: {
      model: "databricks-gpt-5-2",
      instructions: "You are a code helper...",
    },
  },
  defaultAgent: "assistant",
});
```

```ts
// Custom adapter
import { VercelAIAdapter } from "@databricks/appkit/agents/vercel-ai";

createAgent({
  plugins: [analytics()],
  adapter: new VercelAIAdapter({ model }),
});
```
