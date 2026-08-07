# Interface: EntityMutationHooks\<TTable\>

Mutation lifecycle for one entity. A before hook may return a replacement
payload, which is revalidated against the trusted schema before it is
persisted. Every hook, the mutation, and any write a hook issues through
`ctx.app.database` share one transaction, so a rejection anywhere rolls all
of them back. Throw `DatabaseValidationError` to answer a generated route
with `422`; any other failure stays an opaque server error.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TTable` *extends* `string` | `string` |

## Methods

### afterCreate()?

```ts
optional afterCreate(row: FacetOf<TTable, "row">, context: HookContext): MaybePromise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `FacetOf`\<`TTable`, `"row"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void`\>

***

### afterDelete()?

```ts
optional afterDelete(id: IdValue, context: HookContext): MaybePromise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `id` | `IdValue` |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void`\>

***

### afterUpdate()?

```ts
optional afterUpdate(row: FacetOf<TTable, "row">, context: HookContext): MaybePromise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `FacetOf`\<`TTable`, `"row"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void`\>

***

### afterUpsert()?

```ts
optional afterUpsert(row: FacetOf<TTable, "row">, context: HookContext): MaybePromise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `row` | `FacetOf`\<`TTable`, `"row"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void`\>

***

### beforeCreate()?

```ts
optional beforeCreate(values: FacetOf<TTable, "insert">, context: HookContext): MaybePromise<void | FacetOf<TTable, "insert">>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `FacetOf`\<`TTable`, `"insert"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void` \| `FacetOf`\<`TTable`, `"insert"`\>\>

***

### beforeDelete()?

```ts
optional beforeDelete(id: IdValue, context: HookContext): MaybePromise<void>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `id` | `IdValue` |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void`\>

***

### beforeUpdate()?

```ts
optional beforeUpdate(
   id: IdValue, 
   values: FacetOf<TTable, "update">, 
context: HookContext): MaybePromise<void | FacetOf<TTable, "update">>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `id` | `IdValue` |
| `values` | `FacetOf`\<`TTable`, `"update"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void` \| `FacetOf`\<`TTable`, `"update"`\>\>

***

### beforeUpsert()?

```ts
optional beforeUpsert(values: FacetOf<TTable, "insert">, context: HookContext): MaybePromise<void | FacetOf<TTable, "insert">>;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `values` | `FacetOf`\<`TTable`, `"insert"`\> |
| `context` | [`HookContext`](Interface.HookContext.md) |

#### Returns

`MaybePromise`\<`void` \| `FacetOf`\<`TTable`, `"insert"`\>\>
