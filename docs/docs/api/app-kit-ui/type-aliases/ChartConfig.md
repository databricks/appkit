# Type Alias: ChartConfig

```ts
type ChartConfig = { [k in string]: { icon?: React.ComponentType; label?: React.ReactNode } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> }) };
```

Defined in: [packages/app-kit-ui/src/react/ui/chart.tsx:11](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/ui/chart.tsx#L11)
