# Interface: FunctionTool

## Properties

### description?

```ts
optional description: string | null;
```

***

### execute()

```ts
execute: (args: Record<string, unknown>) => string | Promise<string>;
```

Handler invoked when the model calls this tool.

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

JSON Schema object describing the tool's parameters.

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
