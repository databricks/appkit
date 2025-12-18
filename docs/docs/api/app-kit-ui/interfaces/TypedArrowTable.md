# Interface: TypedArrowTable\<TRow\>

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:20](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L20)

Typed Arrow Table - preserves row type information for type inference.
At runtime this is just a regular Arrow Table, but TypeScript knows the row schema.

## Example

```typescript
type MyTable = TypedArrowTable<{ id: string; value: number }>;
// Can access table.getChild("id") knowing it exists
```

## Extends

- `Table`

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TRow` *extends* `Record`\<`string`, `unknown`\> | `Record`\<`string`, `unknown`\> |

## Properties

### \_\_rowType?

```ts
readonly optional __rowType: TRow;
```

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:27](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L27)

Phantom type marker for row schema.
Not used at runtime - only for TypeScript type inference.
