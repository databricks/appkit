# Function: createAgent()

```ts
function createAgent(def: AgentDefinition): AgentDefinition;
```

Pure factory for agent definitions. Returns the passed-in definition after
cycle-detecting the sub-agent graph. Accepts the full `AgentDefinition` shape
and is safe to call at module top-level.

The returned value is a plain `AgentDefinition` — no adapter construction,
no side effects. Register it with `agents({ agents: { name: def } })` or run
it standalone via `runAgent(def, input)`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `def` | [`AgentDefinition`](Interface.AgentDefinition.md) |

## Returns

[`AgentDefinition`](Interface.AgentDefinition.md)

## Example

```ts
const support = createAgent({
  instructions: "You help customers.",
  model: "databricks-claude-sonnet-4-5",
  tools: {
    get_weather: tool({ ... }),
  },
});
```
