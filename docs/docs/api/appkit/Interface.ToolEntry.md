# Interface: ToolEntry\<S\>

Single-tool entry for a plugin's internal tool registry.

Plugins collect these into a `Record<string, ToolEntry>` keyed by the tool's
public name and dispatch via `executeFromRegistry`.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `S` *extends* `z.ZodType` | `z.ZodType` |

## Properties

### annotations?

```ts
optional annotations: ToolAnnotations;
```

***

### autoInheritable?

```ts
optional autoInheritable: boolean;
```

Whether this tool is eligible for auto-inheritance into markdown or
code-defined agents that enable `autoInheritTools`. Defaults to `false`
(safe-by-default) — plugin authors must explicitly opt a tool in if they
consider it safe enough to appear in every agent's tool record without an
explicit `tools:` declaration. Destructive or privilege-sensitive tools
should leave this unset so that they only reach agents that wire them
explicitly (via `tools:`, `toolkits:`, or `fromPlugin({ only: [...] })`).

***

### description

```ts
description: string;
```

***

### handler()

```ts
handler: (args: output<S>, signal?: AbortSignal) => unknown;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `args` | `output`\<`S`\> |
| `signal?` | `AbortSignal` |

#### Returns

`unknown`

***

### schema

```ts
schema: S;
```
