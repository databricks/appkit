# Variable: policy

```ts
const policy: {
  all: FilePolicy;
  allowAll: FilePolicy;
  any: FilePolicy;
  denyAll: FilePolicy;
  not: FilePolicy;
  publicRead: FilePolicy;
};
```

Utility namespace with common policy combinators.

## Type Declaration

### all()

```ts
readonly all(...policies: FilePolicy[]): FilePolicy;
```

AND — all policies must allow. Short-circuits on first denial.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`policies` | `FilePolicy`[] |

#### Returns

`FilePolicy`

### allowAll()

```ts
readonly allowAll(): FilePolicy;
```

Allow every action.

#### Returns

`FilePolicy`

### any()

```ts
readonly any(...policies: FilePolicy[]): FilePolicy;
```

OR — at least one policy must allow. Short-circuits on first allow.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| ...`policies` | `FilePolicy`[] |

#### Returns

`FilePolicy`

### denyAll()

```ts
readonly denyAll(): FilePolicy;
```

Deny every action.

#### Returns

`FilePolicy`

### not()

```ts
readonly not(p: FilePolicy): FilePolicy;
```

Negates a policy.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `p` | `FilePolicy` |

#### Returns

`FilePolicy`

### publicRead()

```ts
readonly publicRead(): FilePolicy;
```

Allow all read actions (list, read, download, raw, exists, metadata, preview).

#### Returns

`FilePolicy`
