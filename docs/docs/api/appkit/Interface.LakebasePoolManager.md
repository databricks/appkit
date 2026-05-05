# Interface: LakebasePoolManager

Manages multiple Lakebase connection pools keyed by an identifier (e.g. userId).

Used for On-Behalf-Of (OBO) scenarios where each user needs their own pool
with their own OAuth token refresh, enabling features like Row-Level Security.

## Properties

### size

```ts
readonly size: number;
```

Number of active pools.

## Methods

### closeAll()

```ts
closeAll(): Promise<void>;
```

Close all managed pools and stop cleanup (for graceful shutdown).

#### Returns

`Promise`\<`void`\>

***

### closePool()

```ts
closePool(key: string): Promise<void>;
```

Close and remove a specific pool.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`Promise`\<`void`\>

***

### getPool()

```ts
getPool(key: string, perPoolConfig: Partial<LakebasePoolConfig>): Pool;
```

Get an existing pool or create a new one for the given key.
When creating, merges `perPoolConfig` with the base config passed to the factory.
On subsequent calls with the same key, `perPoolConfig` is ignored and the cached pool is returned.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `perPoolConfig` | `Partial`\<[`LakebasePoolConfig`](Interface.LakebasePoolConfig.md)\> |

#### Returns

`Pool`

***

### hasPool()

```ts
hasPool(key: string): boolean;
```

Check whether a pool exists for the given key.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`boolean`
