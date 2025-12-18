# Function: FormField()

```ts
function FormField<TFieldValues, TName>(__namedParameters): Element;
```

Defined in: [packages/app-kit-ui/src/react/ui/form.tsx:32](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/ui/form.tsx#L32)

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TFieldValues` *extends* `FieldValues` | `FieldValues` |
| `TName` *extends* `string` | `FieldPath`\<`TFieldValues`\> |

## Parameters

| Parameter | Type |
| ------ | ------ |
| `__namedParameters` | `ControllerProps`\<`TFieldValues`, `TName`\> |

## Returns

`Element`
