# Interface: FkColumnChain

A foreign-key column chain. Returned by `fk(target)`.

## Extends

- [`AppKitColumnChain`](Interface.AppKitColumnChain.md)

## Properties

### $builder

```ts
$builder: unknown;
```

#### Inherited from

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`$builder`](Interface.AppKitColumnChain.md#builder)

***

### $meta

```ts
$meta: ColumnMeta;
```

#### Inherited from

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`$meta`](Interface.AppKitColumnChain.md#meta)

## Methods

### default()

```ts
default<T>(value: T): FkColumnChain;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `T` |

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`default`](Interface.AppKitColumnChain.md#default)

***

### defaultNow()

```ts
defaultNow(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`defaultNow`](Interface.AppKitColumnChain.md#defaultnow)

***

### defaultRandom()

```ts
defaultRandom(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`defaultRandom`](Interface.AppKitColumnChain.md#defaultrandom)

***

### notNull()

```ts
notNull(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`notNull`](Interface.AppKitColumnChain.md#notnull)

***

### onDelete()

```ts
onDelete(value: NonNullable<"cascade" | "set null" | "restrict" | "no action" | undefined>): FkColumnChain;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `NonNullable`\<`"cascade"` \| `"set null"` \| `"restrict"` \| `"no action"` \| `undefined`\> |

#### Returns

`FkColumnChain`

***

### onUpdate()

```ts
onUpdate(value: NonNullable<"cascade" | "set null" | "restrict" | "no action" | undefined>): FkColumnChain;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `NonNullable`\<`"cascade"` \| `"set null"` \| `"restrict"` \| `"no action"` \| `undefined`\> |

#### Returns

`FkColumnChain`

***

### primaryKey()

```ts
primaryKey(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`primaryKey`](Interface.AppKitColumnChain.md#primarykey)

***

### private()

```ts
private(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`private`](Interface.AppKitColumnChain.md#private)

***

### unique()

```ts
unique(): FkColumnChain;
```

#### Returns

`FkColumnChain`

#### Overrides

[`AppKitColumnChain`](Interface.AppKitColumnChain.md).[`unique`](Interface.AppKitColumnChain.md#unique)
