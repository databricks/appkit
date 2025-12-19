# Function: formatLabel()

```ts
function formatLabel(field): string;
```

Defined in: [packages/appkit-ui/src/react/charts/utils.ts:40](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/utils.ts#L40)

Formats a field name into a human-readable label.
Handles camelCase, snake_case, acronyms, and ALL_CAPS.
E.g., "totalSpend" -> "Total Spend", "user_name" -> "User Name",
      "userID" -> "User Id", "TOTAL_SPEND" -> "Total Spend"

## Parameters

| Parameter | Type |
| ------ | ------ |
| `field` | `string` |

## Returns

`string`
