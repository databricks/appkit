import { flexRender } from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { formatFieldLabel } from "../lib/format";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { TableWrapper } from "./table-wrapper";
import type { DataTableLabels, DataTableProps } from "./types";

/**
 * Data table component with automatic query execution and rich features.
 *
 * Provides a full-featured table with:
 * - Automatic column generation from query results
 * - Built-in sorting, filtering, and pagination
 * - Column visibility controls
 * - Loading, error, and empty states
 * - Responsive design
 * - Customizable labels and styling
 *
 * @param props - Data table configuration
 * @param props.queryKey - Analytics query identifier
 * @param props.parameters - Query parameters
 * @param props.transformer - Optional data transformation function
 * @param props.filterColumn - Column name to enable text filtering
 * @param props.filterPlaceholder - Placeholder text for filter input
 * @param props.labels - Custom labels for UI elements
 * @param props.children - Optional custom column definitions for full control
 * @returns Rendered data table with all features
 *
 * @example
 * Basic data table
 * ```typescript
 * import { DataTable } from '@databricks/app-kit-ui';
 *
 * function UsersList() {
 *   return (
 *     <DataTable
 *       queryKey="users_list"
 *  parameters={{ status: "active" }}
 *  filterColumn="email"
 *  filterPlaceholder="Filter by email..."
 * />
 * @example
 * // full control mode
 * <DataTable queryKey="users-list" parameters={{ status: "active" }}>
 *   {(table) => (
 *     <div>
 *       <h2>Custom Table UI</h2>
 *       {table.getRowModel().rows.map(row => (
 *         <div key={row.id}>{row.original.name}</div>
 *       ))}
 *     </div>
 *   )}
 * </DataTable>
 */
export function DataTable(props: DataTableProps) {
  const {
    parameters,
    queryKey,
    filterColumn,
    filterPlaceholder,
    transform,
    labels,
    ariaLabel,
    testId,
    className,
    enableRowSelection,
    onRowSelectionChange,
    children,
    pageSize = 10,
    pageSizeOptions = [10, 25, 50, 100],
  } = props;

  const defaultLabels: Required<DataTableLabels> = {
    columnsButton: "Columns",
    noResults: "No results found.",
    rowsFound: `\${count} row(s) found`,
    previousButton: "Previous",
    nextButton: "Next",
    rowsPerPage: "Rows per page",
    showing: `Showing \${from} to \${to} of \${total}`,
  };

  const finalLabels = { ...defaultLabels, ...labels };

  return (
    <TableWrapper
      queryKey={queryKey}
      parameters={parameters}
      ariaLabel={ariaLabel}
      testId={testId}
      className={className}
      transformer={transform}
      enableRowSelection={enableRowSelection}
      onRowSelectionChange={onRowSelectionChange}
      pageSize={pageSize}
    >
      {(table) => {
        if (children) {
          return children(table);
        }

        const data = table.options.data;

        const defaultFilterColumn =
          filterColumn ||
          (data && data.length > 0
            ? Object.keys(data[0] as Record<string, any>).find(
                (key) =>
                  typeof (data[0] as Record<string, any>)[key] === "string",
              )
            : null);

        const totalRows = table.getFilteredRowModel().rows.length;
        const currentPage = table.getState().pagination.pageIndex + 1;
        const currentPageSize = table.getState().pagination.pageSize;
        const fromRow =
          totalRows === 0 ? 0 : (currentPage - 1) * currentPageSize + 1;
        const toRow = Math.min(currentPage * currentPageSize, totalRows);

        return (
          <div className="w-full">
            <div className="flex items-center py-4 gap-2">
              {defaultFilterColumn && (
                <Input
                  placeholder={
                    filterPlaceholder ||
                    `Filter by ${formatFieldLabel(defaultFilterColumn)}...`
                  }
                  value={
                    (table
                      .getColumn(defaultFilterColumn)
                      ?.getFilterValue() as string) ?? ""
                  }
                  onChange={(event) =>
                    table
                      .getColumn(defaultFilterColumn)
                      ?.setFilterValue(event.target.value)
                  }
                  className="max-w-sm"
                />
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="ml-auto">
                    {finalLabels.columnsButton}{" "}
                    <ChevronDown className="ml-2 h-4 w-4" />
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
                          {formatFieldLabel(column.id)}
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
                          const isSelectColumn = header.column.id === "select";
                          return (
                            <TableHead
                              key={header.id}
                              style={{
                                width: header.getSize(),
                                position: "relative",
                              }}
                              className={
                                isSelectColumn ? "w-[40px] p-0" : undefined
                              }
                            >
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
                          {row.getVisibleCells().map((cell) => {
                            const isSelectColumn = cell.column.id === "select";
                            return (
                              <TableCell
                                key={cell.id}
                                style={{
                                  width: cell.column.getSize(),
                                }}
                                className={
                                  isSelectColumn ? "w-[40px] p-0" : undefined
                                }
                              >
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext(),
                                )}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          colSpan={table.getAllColumns().length}
                          className="h-24 text-center"
                        >
                          {finalLabels.noResults}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="flex items-center justify-between py-4">
              <div className="flex items-center gap-6">
                <div className="text-foreground text-sm">
                  {totalRows > 0
                    ? finalLabels.showing
                        .replace(`\${from}`, fromRow.toString())
                        .replace(`\${to}`, toRow.toString())
                        .replace(`\${total}`, totalRows.toString())
                    : finalLabels.noResults}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">
                    {finalLabels.rowsPerPage}
                  </span>
                  <Select
                    value={currentPageSize.toString()}
                    onValueChange={(value) => {
                      table.setPageSize(Number(value));
                    }}
                  >
                    <SelectTrigger className="w-[70px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {pageSizeOptions.map((size) => (
                        <SelectItem key={size} value={size.toString()}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  {finalLabels.previousButton}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  {finalLabels.nextButton}
                </Button>
              </div>
            </div>
          </div>
        );
      }}
    </TableWrapper>
  );
}
