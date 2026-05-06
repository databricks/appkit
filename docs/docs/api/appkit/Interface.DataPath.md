# Interface: DataPath

AppKit-shaped abstraction over the runtime data path.

The entity proxy and route layer talk to this interface only. The
implementation in `drizzle-runtime.ts` is the *only* AppKit file that
imports `drizzle-orm` for query execution. Swapping Drizzle for Kysely,
Knex, or raw SQL means rewriting one file.

Identity, OBO, telemetry, hook dispatch, and validation all live above this
interface — `DataPath` is plain "execute these reads/writes against this
pool". Pool selection (SP vs per-user) happens in `entity-wiring.ts`.

## Methods

### count()

```ts
count(table: AppKitTable, opts: CountOptions): Promise<number>;
```

Count rows matching `where`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `opts` | [`CountOptions`](Interface.CountOptions.md) |

#### Returns

`Promise`\<`number`\>

***

### delete()

```ts
delete(
   table: AppKitTable, 
   pkColumn: string, 
   id: string | number, 
signal?: AbortSignal): Promise<void>;
```

DELETE one row by primary key. No-op when no row matches.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `pkColumn` | `string` |
| `id` | `string` \| `number` |
| `signal?` | `AbortSignal` |

#### Returns

`Promise`\<`void`\>

***

### findOne()

```ts
findOne(
   table: AppKitTable, 
   pkColumn: string, 
   id: string | number, 
opts?: FindOneOptions): Promise<Row | null>;
```

Find one row by primary key, or `null` when no row matches.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `pkColumn` | `string` |
| `id` | `string` \| `number` |
| `opts?` | `FindOneOptions` |

#### Returns

`Promise`\<`Row` \| `null`\>

***

### insert()

```ts
insert(
   table: AppKitTable, 
   data: Row, 
signal?: AbortSignal): Promise<Row>;
```

INSERT one row and return the inserted row (with server-generated columns).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `data` | `Row` |
| `signal?` | `AbortSignal` |

#### Returns

`Promise`\<`Row`\>

***

### raw()

```ts
raw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
```

Tagged-template SQL escape hatch. Values are bound as parameters; column
and identifier interpolation is intentionally not supported here — drop
to `appkit.database.getPool().query(...)` if you need that.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `T` | `Row` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `strings` | `TemplateStringsArray` |
| ...`values` | `unknown`[] |

#### Returns

`Promise`\<`T`[]\>

***

### select()

```ts
select(table: AppKitTable, opts: SelectOptions): Promise<Row[]>;
```

Run a SELECT and return rows (with optional eager joins).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `opts` | [`SelectOptions`](Interface.SelectOptions.md) |

#### Returns

`Promise`\<`Row`[]\>

***

### transaction()

```ts
transaction<T>(fn: (tx: DataPath) => Promise<T>): Promise<T>;
```

Run `fn` inside a database transaction. The nested `DataPath` shares the
same surface; rollbacks happen on throw, commits on resolution.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | (`tx`: `DataPath`) => `Promise`\<`T`\> |

#### Returns

`Promise`\<`T`\>

***

### update()

```ts
update(
   table: AppKitTable, 
   pkColumn: string, 
   id: string | number, 
   patch: Row, 
signal?: AbortSignal): Promise<Row | null>;
```

UPDATE one row by primary key. Returns the updated row, or `null` when
no row matches. Hook dispatch and Zod validation happen above this layer.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `pkColumn` | `string` |
| `id` | `string` \| `number` |
| `patch` | `Row` |
| `signal?` | `AbortSignal` |

#### Returns

`Promise`\<`Row` \| `null`\>

***

### upsert()

```ts
upsert(
   table: AppKitTable, 
   data: Row, 
   options: {
  onConflict: string;
}, 
signal?: AbortSignal): Promise<Row>;
```

INSERT … ON CONFLICT (`onConflict`) DO UPDATE. Returns the resulting row.
`onConflict` is a column name in the table (single-column unique constraint).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `table` | [`AppKitTable`](Interface.AppKitTable.md) |
| `data` | `Row` |
| `options` | \{ `onConflict`: `string`; \} |
| `options.onConflict` | `string` |
| `signal?` | `AbortSignal` |

#### Returns

`Promise`\<`Row`\>
