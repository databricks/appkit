# Function: DataTable()

```ts
function DataTable(props): Element;
```

Defined in: [packages/appkit-ui/src/react/table/data-table.tsx:68](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/table/data-table.tsx#L68)

Production-ready data table with automatic data fetching and state management
Features:
 - Automatic column generation from data structure
 - Integrated with useAnalyticsQuery for data fetching
 - Built-in loading, error, and empty states
 - Dynamic filtering, sorting and pagination
 - Column visibility controls
 - Responsive design

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | `DataTableProps` | Props for the DataTable component |

## Returns

`Element`

- The rendered data table component

## Examples

```ts
// Opinionated mode
<DataTable
 queryKey="users-list"
 parameters={{ status: "active" }}
 filterColumn="email"
 filterPlaceholder="Filter by email..."
/>
```

```ts
// full control mode
<DataTable queryKey="users-list" parameters={{ status: "active" }}>
  {(table) => (
    <div>
      <h2>Custom Table UI</h2>
      {table.getRowModel().rows.map(row => (
        <div key={row.id}>{row.original.name}</div>
      ))}
    </div>
  )}
</DataTable>
```
