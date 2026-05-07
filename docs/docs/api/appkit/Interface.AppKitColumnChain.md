# Interface: AppKitColumnChain

A chain of AppKit column methods. This is returned by the column builder methods.

## Extends

- [`AppKitColumn`](Interface.AppKitColumn.md)

## Extended by

- [`FkColumnChain`](Interface.FkColumnChain.md)

## Properties

### $builder

```ts
$builder: unknown;
```

#### Inherited from

[`AppKitColumn`](Interface.AppKitColumn.md).[`$builder`](Interface.AppKitColumn.md#builder)

***

### $meta

```ts
$meta: ColumnMeta;
```

#### Inherited from

[`AppKitColumn`](Interface.AppKitColumn.md).[`$meta`](Interface.AppKitColumn.md#meta)

## Methods

### default()

```ts
default<T>(value: T): AppKitColumnChain;
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

`AppKitColumnChain`

***

### defaultNow()

```ts
defaultNow(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`

***

### defaultRandom()

```ts
defaultRandom(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`

***

### notNull()

```ts
notNull(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`

***

### primaryKey()

```ts
primaryKey(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`

***

### private()

```ts
private(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`

***

### unique()

```ts
unique(): AppKitColumnChain;
```

#### Returns

`AppKitColumnChain`
