# Type Alias: DatabaseExports

```ts
type DatabaseExports = TransactionClient & {
  transaction: Promise<T>;
};
```

Typed database API published by the plugin.

## Type Declaration

### transaction()

```ts
transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `callback` | (`tx`: `TransactionClient`) => `Promise`\<`T`\> |

#### Returns

`Promise`\<`T`\>
