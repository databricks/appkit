# Interface: ToolConfig\<S\>

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `z.ZodType` |

## Properties

### annotations?

```ts
optional annotations: ToolAnnotations;
```

Behavioural hints forwarded to the resolved tool definition. Prefer
`effect` (`"read" | "write" | "update" | "destructive"`) — any mutating
value forces the agents-plugin approval gate before `execute()` runs
and the client's approval card will colour itself accordingly. Legacy
`destructive: true` still gates. Dropped silently before the fix that
added this field.

***

### description?

```ts
optional description: string;
```

***

### execute()

```ts
execute: (args: output<S>) => string | Promise<string>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `output`\<`S`\> |

#### Returns

`string` \| `Promise`\<`string`\>

***

### name

```ts
name: string;
```

***

### schema

```ts
schema: S;
```
