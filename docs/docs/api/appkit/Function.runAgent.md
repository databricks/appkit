# Function: runAgent()

```ts
function runAgent(def: AgentDefinition, input: RunAgentInput): Promise<RunAgentResult>;
```

Standalone agent execution without `createApp`. Resolves the adapter, binds
inline tools, and drives the adapter's `run()` loop to completion.

Limitations vs. running through the agents() plugin:
- No OBO: there is no HTTP request, so plugin tools run as the service
  principal (when they work at all).
- Hosted tools (MCP) are not supported — they require a live MCP client
  that only exists inside the agents plugin.
- Sub-agents (`agents: { ... }` on the def) are executed as nested
  `runAgent` calls with no shared thread state.
- Plugin tools (`fromPlugin` markers or `ToolkitEntry` spreads) require
  passing `plugins: [...]` via `RunAgentInput`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `def` | [`AgentDefinition`](Interface.AgentDefinition.md) |
| `input` | [`RunAgentInput`](Interface.RunAgentInput.md) |

## Returns

`Promise`\<[`RunAgentResult`](Interface.RunAgentResult.md)\>
