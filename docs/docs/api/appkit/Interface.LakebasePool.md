# Interface: LakebasePool

Subset of `pg.Pool` exposed by the Lakebase plugin.

RoutingPool does not extend EventEmitter — event listener methods
like `on('error', ...)` are not available. Use `query()`, `connect()`,
and `end()` for all pool operations.

## Properties

### idleCount

```ts
readonly idleCount: number;
```

***

### totalCount

```ts
readonly totalCount: number;
```

***

### waitingCount

```ts
readonly waitingCount: number;
```

## Methods

### connect()

```ts
connect(): Promise<PoolClient>;
```

#### Returns

`Promise`\<`PoolClient`\>

***

### end()

```ts
end(): Promise<void>;
```

#### Returns

`Promise`\<`void`\>

***

### query()

```ts
query<T>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
```

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` *extends* `QueryResultRow` | `any` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `text` | `string` |
| `values?` | `unknown`[] |

#### Returns

`Promise`\<`QueryResult`\<`T`\>\>
