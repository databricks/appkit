# CLAUDE.md - @databricks/app-kit-ui

AI assistant guidance for the Databricks AppKit UI component library.

## Overview

`@databricks/app-kit-ui` provides React components and JavaScript utilities for building Databricks application frontends. It includes data visualization charts, data tables, and SSE utilities that integrate seamlessly with the `@databricks/app-kit` backend.

## Installation & Imports

```typescript
// React components
import { BarChart, LineChart, DataTable, useAnalyticsQuery } from "@databricks/app-kit-ui/react";

// JavaScript utilities (SSE, SQL helpers)
import { connectSSE, sql } from "@databricks/app-kit-ui/js";

// Global styles (include in your app entry)
import "@databricks/app-kit-ui/styles.css";
```

## Chart Components

All charts integrate with the analytics backend via `queryKey` and support two modes:
- **Opinionated mode**: Automatic field detection and rendering
- **Full control mode**: Pass children for custom Recharts configuration

### BarChart

```tsx
import { BarChart } from "@databricks/app-kit-ui/react";

// Opinionated mode - auto-detects x/y fields
<BarChart 
  queryKey="top_contributors" 
  parameters={{ limit: 10 }} 
/>

// Horizontal orientation
<BarChart 
  queryKey="top_contributors" 
  parameters={{ limit: 10 }}
  orientation="horizontal"
/>

// With data transformation
<BarChart 
  queryKey="top_contributors" 
  parameters={{ limit: 10 }}
  transformer={(data) => data.map(d => ({ name: d.user, count: d.total }))}
/>

// Full control mode
<BarChart queryKey="top_contributors" parameters={{ limit: 10 }}>
  <Bar dataKey="value" fill="var(--color-primary)" />
  <XAxis dataKey="name" />
</BarChart>
```

### LineChart

```tsx
import { LineChart } from "@databricks/app-kit-ui/react";

<LineChart 
  queryKey="daily_metrics" 
  parameters={{ days: 30 }}
  height="400px"
/>
```

### AreaChart

```tsx
import { AreaChart } from "@databricks/app-kit-ui/react";

<AreaChart 
  queryKey="hourly_traffic" 
  parameters={{ hours: 24 }}
/>
```

### PieChart

```tsx
import { PieChart } from "@databricks/app-kit-ui/react";

<PieChart 
  queryKey="category_breakdown" 
  parameters={{ year: 2024 }}
/>
```

### RadarChart

```tsx
import { RadarChart } from "@databricks/app-kit-ui/react";

<RadarChart 
  queryKey="skill_assessment" 
  parameters={{ userId: "123" }}
/>
```

### Common Chart Props

| Prop | Type | Description |
|------|------|-------------|
| `queryKey` | `string` | Analytics query identifier (maps to `config/queries/*.sql`) |
| `parameters` | `object` | Query parameters |
| `transformer` | `(data) => data` | Transform data before rendering |
| `height` | `string` | Chart height (default: "300px") |
| `orientation` | `"vertical" \| "horizontal"` | Bar chart orientation |
| `chartConfig` | `ChartConfig` | Custom Recharts config |
| `ariaLabel` | `string` | Accessibility label |
| `testId` | `string` | Test ID attribute |
| `className` | `string` | Additional CSS classes |

## DataTable Component

Production-ready data table with automatic data fetching, filtering, sorting, and pagination:

```tsx
import { DataTable } from "@databricks/app-kit-ui/react";

// Opinionated mode
<DataTable
  queryKey="users_list"
  parameters={{ status: "active" }}
  filterColumn="email"
  filterPlaceholder="Filter by email..."
  pageSize={25}
/>

// With row selection
<DataTable
  queryKey="orders_list"
  parameters={{}}
  enableRowSelection
  onRowSelectionChange={(selection) => console.log(selection)}
/>

// Full control mode
<DataTable queryKey="users_list" parameters={{}}>
  {(table) => (
    <div>
      {table.getRowModel().rows.map(row => (
        <div key={row.id}>{row.original.name}</div>
      ))}
    </div>
  )}
</DataTable>
```

### DataTable Props

| Prop | Type | Description |
|------|------|-------------|
| `queryKey` | `string` | Analytics query identifier |
| `parameters` | `object` | Query parameters |
| `filterColumn` | `string` | Column to filter by (auto-detected if not set) |
| `filterPlaceholder` | `string` | Filter input placeholder |
| `transform` | `(data) => data` | Transform data before rendering |
| `pageSize` | `number` | Rows per page (default: 10) |
| `pageSizeOptions` | `number[]` | Page size options (default: [10, 25, 50, 100]) |
| `enableRowSelection` | `boolean` | Enable row selection checkboxes |
| `onRowSelectionChange` | `(selection) => void` | Row selection callback |
| `labels` | `DataTableLabels` | Customize UI labels |

## Hooks

### useAnalyticsQuery

Subscribe to analytics queries via SSE with automatic state management:

```tsx
import { useAnalyticsQuery } from "@databricks/app-kit-ui/react";

function UserList() {
  const { data, loading, error } = useAnalyticsQuery(
    "users_list",           // queryKey
    { status: "active" },   // parameters
    { autoStart: true }     // options
  );

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  
  return (
    <ul>
      {data?.map(user => <li key={user.id}>{user.name}</li>)}
    </ul>
  );
}
```

### useChartData

Lower-level hook for fetching chart data:

```tsx
import { useChartData } from "@databricks/app-kit-ui/react";

const { data, loading, error } = useChartData({
  queryKey: "metrics",
  parameters: { days: 30 },
  transformer: (raw) => raw.filter(d => d.value > 0),
});
```

## SSE Utilities (JavaScript)

### connectSSE

Connect to SSE endpoints with automatic retries:

```typescript
import { connectSSE } from "@databricks/app-kit-ui/js";

await connectSSE({
  url: "/api/stream/events",
  payload: { filter: "important" },  // Optional POST body
  onMessage: (message) => {
    console.log("Received:", JSON.parse(message.data));
  },
  onError: (error) => {
    console.error("SSE error:", error);
  },
  signal: abortController.signal,
  maxRetries: 3,
  retryDelay: 2000,
  timeout: 300000,
});
```

### SQL Type Markers

Type-safe SQL parameter helpers:

```typescript
import { sql } from "@databricks/app-kit-ui/js";

const params = {
  userId: sql.string("user-123"),
  createdAt: sql.timestamp(new Date()),
  isActive: sql.boolean(true),
  count: sql.number(42),
};
```

## Styling

### CSS Variables

The library uses CSS variables for theming. Include the base styles:

```tsx
// In your app entry (e.g., main.tsx)
import "@databricks/app-kit-ui/styles.css";
```

### Tailwind Integration

Components use Tailwind CSS classes. Extend your `tailwind.config.ts`:

```typescript
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@databricks/app-kit-ui/dist/**/*.{js,mjs}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: "hsl(var(--primary))",
        // ... other theme colors
      },
    },
  },
};
```

## Integration with app-kit Backend

Charts and tables automatically connect to `@databricks/app-kit` analytics endpoints:

```
Frontend                          Backend
────────                          ───────
<BarChart queryKey="sales" />
         │
         └─► POST /api/analytics/query/sales
                    │
                    └─► config/queries/sales.sql
                               │
                               └─► SQL Warehouse
```

**Query files** are stored in `config/queries/<queryKey>.sql` on the backend.

## Best Practices

1. **Always include styles**: Import `@databricks/app-kit-ui/styles.css` in your app entry
2. **Use queryKey naming**: Match `queryKey` props to SQL file names in `config/queries/`
3. **Handle loading states**: All components handle loading/error states, but you can customize
4. **Prefer opinionated mode**: Start with auto-detection, switch to full control when needed
5. **Use transformers**: Apply data transformations via `transformer`/`transform` props, not in render

## Anti-Patterns

- Do not import from internal paths (e.g., `@databricks/app-kit-ui/dist/...`)
- Do not skip the styles import (components may render incorrectly)
- Do not use inline SQL in parameters (SQL lives in backend query files)
- Do not call hooks conditionally (React rules apply)
- Do not mutate data in transformers (return new arrays/objects)

