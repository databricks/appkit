# Class: PolicyDeniedError

Thrown when a policy denies an action.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new PolicyDeniedError(action: FileAction, volumeKey: string): PolicyDeniedError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `action` | [`FileAction`](TypeAlias.FileAction.md) |
| `volumeKey` | `string` |

#### Returns

`PolicyDeniedError`

#### Overrides

```ts
Error.constructor
```

## Properties

### action

```ts
readonly action: FileAction;
```

***

### volumeKey

```ts
readonly volumeKey: string;
```
