# Interface: OperationDefinition\<M, I, O, R, Name\>

One immutable operation descriptor. Nothing in it runs until a request does.

## Type Parameters

| Type Parameter |
| ------ |
| `M` *extends* [`OperationMethod`](TypeAlias.OperationMethod.md) |
| `I` *extends* `SchemaSlot` |
| `O` *extends* `SchemaSlot` |
| `R` |
| `Name` *extends* `string` |

## Properties

### authorize

```ts
readonly authorize: Authorize<ParsedInput<I>, R>;
```

***

### execute()

```ts
readonly execute: (context: OperationContext<ParsedInput<I>, [R] extends [undefined] ? undefined : NonNullable<Awaited<R>>>) => Awaitable<ExecuteResult<M, O>>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`OperationContext`](Interface.OperationContext.md)\<`ParsedInput`\<`I`\>, \[`R`\] *extends* \[`undefined`\] ? `undefined` : `NonNullable`\<`Awaited`\<`R`\>\>\> |

#### Returns

`Awaitable`\<`ExecuteResult`\<`M`, `O`\>\>

***

### input

```ts
readonly input: I;
```

***

### method

```ts
readonly method: M;
```

***

### name

```ts
readonly name: Name;
```

***

### output

```ts
readonly output: O;
```
