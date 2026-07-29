# Interface: AgentAdapter

## Properties

### acceptsExtensions?

```ts
readonly optional acceptsExtensions: readonly string[];
```

Extension keys this adapter consumes from [AgentInput.extensions](Interface.AgentInput.md#extensions).
The agents plugin (and standalone `runAgent`) warns at registration
if the tool index produces extensions whose keys aren't listed here.

Adapters that don't read extensions can omit this field.

***

### consumesInputTools?

```ts
readonly optional consumesInputTools: boolean;
```

Whether the adapter consumes tools from `input.tools`. Defaults to
true. Adapters whose tool execution happens elsewhere (e.g. the
Supervisor API, where SA owns the tool loop server-side) declare
false; the agents plugin warns at registration if the agent declares
function tools or local sub-agents alongside such an adapter, since
those tools would never reach the model.

## Methods

### run()

```ts
run(input: AgentInput, context: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`AgentInput`](Interface.AgentInput.md) |
| `context` | [`AgentRunContext`](Interface.AgentRunContext.md) |

#### Returns

`AsyncGenerator`\<[`AgentEvent`](TypeAlias.AgentEvent.md), `void`, `unknown`\>
