# Function: fk()

```ts
function fk(target: AppKitColumn): FkColumnChain;
```

Create a foreign key column. The reference target is captured live and
resolved at `buildTable()` time, so forward references (e.g. `fk(other.id)`
declared before `table("other", ...)`) work. When the target was already
built, `toTable`/`toColumn` are populated immediately so the introspector
doesn't depend on define-schema's deferred resolver running first.

The FK column type is currently fixed to `integer`. If the target is a
`bigid()` (`bigserial`) or `uuid()` PK, declare the FK column with the
matching type explicitly until per-target type inference is added.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `target` | [`AppKitColumn`](Interface.AppKitColumn.md) | The target column to reference. |

## Returns

[`FkColumnChain`](Interface.FkColumnChain.md)

A FK column chain. `onDelete`/`onUpdate` return the FK chain so
order does not matter; chain methods (`.notNull()`, `.unique()`, etc.) also
return the FK chain so `.notNull().onDelete("cascade")` typechecks.
