# Function: createAgent()

```ts
function createAgent(config: CreateAgentConfig): Promise<AgentHandle>;
```

Creates an agent-powered app with batteries included.

Wraps `createApp` with `server()` and `agent()` pre-configured.
Automatically starts an HTTP server with agent chat routes.

When no `adapter` is provided, a `SupervisorApiAdapter` is created
automatically using `model`, `instructions`, and `tools` from config.

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
import { createAgent } from "@databricks/appkit";
import { VercelAIAdapter } from "@databricks/appkit/agents/vercel-ai";

createAgent({
  plugins: [analytics()],
  adapter: new VercelAIAdapter({ model }),
});
```
