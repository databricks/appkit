# Interface: OperationContext\<In, R\>

What `allow` and `execute` receive: the policy context and the loaded resource.

## Extends

- [`PolicyContext`](Interface.PolicyContext.md)\<`In`\>

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `In` | `unknown` |
| `R` | `undefined` |

## Properties

### actor

```ts
readonly actor: Actor;
```

#### Inherited from

[`PolicyContext`](Interface.PolicyContext.md).[`actor`](Interface.PolicyContext.md#actor)

***

### appkit

```ts
readonly appkit: OperationAppKit;
```

#### Inherited from

[`PolicyContext`](Interface.PolicyContext.md).[`appkit`](Interface.PolicyContext.md#appkit)

***

### db

```ts
readonly db: DatabaseExports;
```

#### Inherited from

[`PolicyContext`](Interface.PolicyContext.md).[`db`](Interface.PolicyContext.md#db)

***

### input

```ts
readonly input: In;
```

#### Inherited from

[`PolicyContext`](Interface.PolicyContext.md).[`input`](Interface.PolicyContext.md#input)

***

### resource

```ts
readonly resource: R;
```
