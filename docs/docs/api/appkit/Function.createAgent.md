# Function: createAgent()

```ts
function createAgent(def: AgentDefinition): AgentDefinition;
```

Pure factory for agent definitions: cycle-detects the sub-agent graph and
returns the same object, stamped with a non-enumerable AGENT\_BRAND
so discovery recognizes it. Safe at module top-level; no adapter is built.
Don't `Object.freeze` the definition before passing it in — the brand is
written onto the argument.

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
