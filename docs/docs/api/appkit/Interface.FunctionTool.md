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
is still honoured. Must be preserved through functionToolToDefinition so the plugin sees them when building agent
tool indexes.

***

### description?

```ts
optional description: string | null;
```

***

### execute()

```ts
execute: (args: Record<string, unknown>) => string | Promise<string>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `Record`\<`string`, `unknown`\> |

#### Returns

`string` \| `Promise`\<`string`\>

***

### name

```ts
name: string;
```

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
