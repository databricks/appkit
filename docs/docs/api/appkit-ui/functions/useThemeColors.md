# Function: useThemeColors()

```ts
function useThemeColors(palette): string[];
```

Defined in: [packages/appkit-ui/src/react/charts/theme.ts:91](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/theme.ts#L91)

Hook to get theme colors with automatic updates on theme change.
Re-resolves CSS variables when color scheme or theme attributes change.

## Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `palette` | [`ChartColorPalette`](../type-aliases/ChartColorPalette.md) | `"categorical"` | Color palette type: "categorical" (default), "sequential", or "diverging" |

## Returns

`string`[]
