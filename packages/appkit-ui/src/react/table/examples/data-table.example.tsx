"use client";

import { DataTable } from "@databricks/appkit-ui/react";

export default function DataTableExample() {
  return (
    <DataTable
      queryKey="example_query"
      parameters={{}}
      filterColumn="name"
      filterPlaceholder="Filter by name..."
      pageSize={10}
    />
  );
}
