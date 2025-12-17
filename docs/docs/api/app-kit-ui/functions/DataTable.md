# Function: DataTable()

```ts
function DataTable(props): Element;
```

Defined in: [packages/app-kit-ui/src/react/table/data-table.tsx:77](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/table/data-table.tsx#L77)

Data table component with automatic query execution and rich features.

Provides a full-featured table with:
- Automatic column generation from query results
- Built-in sorting, filtering, and pagination
- Column visibility controls
- Loading, error, and empty states
- Responsive design
- Customizable labels and styling

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | `DataTableProps` | Data table configuration |

## Returns

`Element`

Rendered data table with all features

## Example

Basic data table
```typescript
import { DataTable } from '@databricks/app-kit-ui';

function UsersList() {
  return (
    <DataTable
      queryKey="users_list"
 parameters={{ status: "active" }}
 filterColumn="email"
 filterPlaceholder="Filter by email..."
/>
@example
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
