# Type Alias: ChartConfig

```ts
type ChartConfig = { [k in string]: { icon?: React.ComponentType; label?: React.ReactNode } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> }) };
```

Defined in: [packages/appkit-ui/src/react/ui/chart.tsx:11](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/ui/chart.tsx#L11)
