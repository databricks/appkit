# Interface: OperationContext\<I\>

What `authorize` and `execute` receive. `db` always runs as the app's service principal.

## Type Parameters

| Type Parameter |
| ------ |
| `I` |

## Properties

### actor

```ts
readonly actor: Actor;
```

***

### db

```ts
readonly db: TransactionClient;
```

***

### input

```ts
readonly input: I;
```
