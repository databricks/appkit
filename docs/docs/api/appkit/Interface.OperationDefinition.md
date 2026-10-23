# Interface: OperationDefinition\<E, M, I, O, R, Name\>

One immutable operation descriptor. Nothing in it runs until a request does.

## Type Parameters

| Type Parameter |
| ------ |
| `E` *extends* `EntityName` |
| `M` *extends* [`OperationMethod`](TypeAlias.OperationMethod.md) |
| `I` *extends* `SchemaSlot` |
| `O` *extends* `SchemaSlot` |
| `R` |
| `Name` *extends* `string` |

## Properties

### authorize

```ts
readonly authorize: Authorize<ParsedInput<E, M, I>, R>;
```

***

### entity

```ts
readonly entity: E;
```

***

### execute()

```ts
readonly execute: (context: OperationContext<ParsedInput<E, M, I>, [R] extends [undefined] ? undefined : NonNullable<Awaited<R>>>) => Awaitable<ExecuteResult<E, M, O>>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `context` | [`OperationContext`](Interface.OperationContext.md)\<`ParsedInput`\<`E`, `M`, `I`\>, \[`R`\] *extends* \[`undefined`\] ? `undefined` : `NonNullable`\<`Awaited`\<`R`\>\>\> |

#### Returns

`Awaitable`\<`ExecuteResult`\<`E`, `M`, `O`\>\>

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
