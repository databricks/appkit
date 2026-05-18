# Interface: FunctionTool

## Properties

### annotations?

```ts
optional annotations: ToolAnnotations;
```

Behavioural hints that drive the agents plugin's approval gate and the
client's approval-card styling. Prefer setting `effect` (one of
`"read" | "write" | "update" | "destructive"`) — any mutating value
forces HITL approval before `execute()` runs. Legacy `destructive: true`
is still honoured. Must be preserved through [functionToolToDefinition](Function.functionToolToDefinition.md) so the plugin sees them when building agent
tool indexes.

***

### description?

```ts
optional description: string | null;
```

***

### execute()

```ts
execute: (args: Record<string, unknown>) => unknown;
```

Returns any shape; downstream `normalizeToolResult` serializes to a
string before handing the value to the LLM.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `Record`\<`string`, `unknown`\> |

#### Returns

`unknown`

***

### name?

```ts
optional name: string;
```

Optional. When this tool is placed in a keyed record
(`tools: { my_tool: ... }` or the function form), the agents plugin
overrides this with the record key at index-build time. Only set it
explicitly when constructing a `FunctionTool` outside any
keyed-record context.

***

### parameters?

```ts
optional parameters: Record<string, unknown> | null;
```

***

### strict?

```ts
optional strict: boolean | null;
```

***

### type

```ts
type: "function";
```
