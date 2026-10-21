# Interface: Operation\<S, R\>

## Extends

- `OperationDefinition`\<`S`, `R`\>

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `S` *extends* `z.ZodType` | `z.ZodType` |
| `R` | `unknown` |

## Properties

### authorize

```ts
readonly authorize: 
  | Policy<output<S>>
  | readonly Policy<output<S>>[];
```

Required: an operation without an authorization decision is never exposed.

#### Inherited from

```ts
OperationDefinition.authorize
```

***

### execute()

```ts
readonly execute: (context: OperationContext<output<S>>) => Promise<R>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`OperationContext`](Interface.OperationContext.md)\<`output`\<`S`\>\> |

#### Returns

`Promise`\<`R`\>

#### Inherited from

```ts
OperationDefinition.execute
```

***

### input

```ts
readonly input: S;
```

#### Inherited from

```ts
OperationDefinition.input
```

***

### kind

```ts
readonly kind: "query" | "mutation";
```
