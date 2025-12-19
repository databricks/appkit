import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@databricks/appkit-ui/react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronDown } from "lucide-react";
import * as React from "react";

export type AppData = {
  id: string;
  name: string;
  creator: string;
  spend: number;
  status: "unknown" | "active" | "inactive" | "untagged";
  tags: string[];
  lastRun: string;
  avgSpend?: number;
};

export const columns: ColumnDef<AppData>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="h-8 px-2"
        >
          App Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => (
      <div className="font-medium">{row.getValue("name")}</div>
    ),
  },
  {
    accessorKey: "creator",
    header: "Creator",
    cell: ({ row }) => <div>{row.getValue("creator")}</div>,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <Badge variant="outline">{row.getValue("status")}</Badge>
    ),
  },
  {
    accessorKey: "tags",
    header: "Tags",
    cell: ({ row }) => {
      const tags = row.getValue("tags") as string[];
      return (
        <div className="flex gap-1 flex-wrap">
          {tags.length > 0 ? (
            tags.map((tag: string) => (
              <Badge key={`${row.original.id}-${tag}`} variant="outline">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No tags</span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "spend",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="h-8 px-2"
        >
          Spend
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      );
    },
    cell: ({ row }) => {
      const spend = parseFloat(row.getValue("spend"));
      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(spend);
      return <div className="text-right font-medium">{formatted}</div>;
    },
  },
  {
    accessorKey: "lastRun",
    header: "Created At",
    cell: ({ row }) => {
      const date = row.getValue("lastRun") as string;
      return <div>{date ? new Date(date).toLocaleDateString() : "N/A"}</div>;
    },
  },
];

interface AppsDataTableProps {
  data: AppData[];
  loading?: boolean;
}

export function AppsDataTable({ data, loading = false }: AppsDataTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});

  const table = useReactTable({
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  if (loading) {
    return (
      <div className="w-full space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-10 w-64 bg-muted animate-pulse rounded" />
          <div className="h-10 w-24 bg-muted animate-pulse rounded" />
        </div>
        <div className="border rounded-md">
          {["row-1", "row-2", "row-3", "row-4", "row-5"].map((id) => (
            <div key={id} className="flex gap-4 p-4 border-b last:border-b-0">
              <div className="h-6 w-full bg-muted animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-center py-4 gap-2">
        <Input
          placeholder="Filter by app name..."
          value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
          onChange={(event) =>
            table.getColumn("name")?.setFilterValue(event.target.value)
          }
          className="max-w-sm"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="ml-auto">
              Columns <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => {
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {column.id}
                  </DropdownMenuCheckboxItem>
                );
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <div className="max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && "selected"}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-24 text-center"
                  >
                    No apps found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="text-muted-foreground flex-1 text-sm">
          {table.getFilteredRowModel().rows.length} app(s) found
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
