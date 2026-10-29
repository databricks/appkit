# Interface: PolicyContext\<In\>

What every authorization callback receives.

## Extended by

- [`OperationContext`](Interface.OperationContext.md)

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `In` | `unknown` |

## Properties

### actor

```ts
readonly actor: Actor;
```

***

### appkit

```ts
readonly appkit: OperationAppKit;
```

***

### db

```ts
readonly db: DatabaseExports;
```

***

### input

```ts
readonly input: In;
```
