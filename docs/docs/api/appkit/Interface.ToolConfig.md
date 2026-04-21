# Interface: ToolConfig\<S\>

## Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* `z.ZodType` |

## Properties

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
