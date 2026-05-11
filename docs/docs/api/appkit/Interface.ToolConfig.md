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

### description

```ts
description: string;
```

What the tool does, what it expects, and when the LLM should call it.
The model reads this verbatim when deciding whether to invoke the tool,
so write it for an LLM, not for a human reader of your code: spell out
the inputs, the return shape, and any pre-conditions or side effects.

Required. Earlier versions silently fell back to the tool's name when
omitted, which surfaced cryptic identifiers like `"get_weather"` as the
description — the model then had no signal about expected use and
either skipped the tool or called it speculatively. Making this
mandatory at the type level forces a real description at authoring
time instead of debugging a confused agent later.

***

### execute()

```ts
execute: (args: output<S>) => unknown;
```

Returning a non-string value is fine: the agent runtime serializes
the result via `normalizeToolResult` before handing it to the LLM
(strings pass through; `null` becomes `"null"`; everything else gets
`JSON.stringify`'d; `undefined` becomes `""`). Return whatever shape
is most natural for your tool — typically an object — and let the
runtime handle the wire format.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `output`\<`S`\> |

#### Returns

`unknown`

***

### name?

```ts
optional name: string;
```

Optional. When the tool is placed in a keyed record (the standard
`tools: { my_tool: tool({...}) }` form, or the function form
`tools(plugins) => ({ my_tool: tool({...}) })`), the agents plugin
overrides the tool's LLM-visible name with the record key. Set
`name` explicitly only if you're constructing a `FunctionTool`
outside any keyed-record context — otherwise the record key wins.

***

### schema

```ts
schema: S;
```
