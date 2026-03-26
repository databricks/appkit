# Function: createAgent()

```ts
function createAgent(config: CreateAgentConfig): Promise<AgentHandle>;
```

Creates an agent-powered app with batteries included.

Wraps `createApp` with `server()` and `agent()` pre-configured.
Automatically starts an HTTP server with agent chat routes.

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
import { DatabricksAdapter } from "@databricks/appkit/agents/databricks";

createAgent({
  plugins: [analytics()],
  adapter: DatabricksAdapter.fromServingEndpoint({
    workspaceClient: new WorkspaceClient({}),
    endpointName: "databricks-claude-sonnet-4-5",
    systemPrompt: "You are a data assistant...",
  }),
}).then(agent => {
  console.log("Tools:", agent.getTools());
});
```

```ts
createAgent({
  plugins: [analytics(), files()],
  agents: {
    assistant: DatabricksAdapter.fromServingEndpoint({ ... }),
    autocomplete: DatabricksAdapter.fromServingEndpoint({ ... }),
  },
  defaultAgent: "assistant",
});
```
