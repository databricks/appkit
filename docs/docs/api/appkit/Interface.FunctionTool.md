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
