import {
  type Column,
  type ColumnFiltersState,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAnalyticsQuery } from "..";
import {
  formatChartValue,
  formatFieldLabel,
  SAFE_KEY_REGEX,
} from "../lib/format";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { EmptyState } from "./empty";
import { ErrorState } from "./error";
import { LoadingSkeleton } from "./loading";
import type { TableWrapperProps } from "./types";

const CHECKBOX_COLUMN_WIDTH = 40;

/**
 * Wrapper component for tables with automatic data fetching and state management
 * This component handles:
 * - Data fetching via useAnalyticsQuery
 * - Loading, error, and empty states with proper UI components
 * - Data transformation (optional)
 * - Dynamic column generation from data structure
 * - TanStack Table instance creation with all features (sorting, filtering, pagination, etc.)
 *
 * @template TRaw - The raw data type returned by the analytics query
 * @template TProcessed - The processed data type after transformation
 *
 * @param props - Props for the TableWrapper component
 * @param props.queryKey - The query key to fetch the data
 * @param props.parameters - The parameters to pass to the query
 * @param props.transformer - Optional function to transform raw data before creating table
 * @param props.asUser - Whether to execute the query as a user. Default is false.
 * @param props.children - Render function that receives the TanStack Table instance
 * @param props.className - Optional CSS class name for the wrapper
 * @param props.ariaLabel - Optional accessibility label
 * @param props.testId - Optional test ID for testing
 *
 * @returns The rendered table with state management
 */
export function TableWrapper<TRaw = any, TProcessed = any>(
  props: TableWrapperProps<TRaw, TProcessed>,
) {
  const {
    queryKey,
    parameters,
    transformer,
    asUser = false,
    children,
    className,
    ariaLabel,
    testId,
    enableRowSelection = false,
    onRowSelectionChange,
    pageSize = 10,
  } = props;

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const { data, loading, error } = useAnalyticsQuery<TRaw[]>(
    queryKey,
    parameters,
    { asUser },
  );

  useEffect(() => {
    if (onRowSelectionChange && enableRowSelection) {
      onRowSelectionChange(rowSelection);
    }
  }, [rowSelection, onRowSelectionChange, enableRowSelection]);

  const hasData = data && data.length > 0;

  const processedData = hasData
    ? transformer
      ? transformer(data)
      : (data as unknown as TProcessed[])
    : [];

  const tableColumns = useMemo(() => {
    if (!hasData) return [];

    if (!processedData[0] || typeof processedData[0] !== "object") {
      console.warn("Invalid data format for DataTable");
      return [];
    }

    const dataColumns = Object.keys(processedData[0] as object)
      .filter((key) => SAFE_KEY_REGEX.test(key))
      .map((key) => {
        const formattedLabel = formatFieldLabel(key);
        return {
          accessorKey: key,
          header: ({ column }: { column: Column<TProcessed> }) => {
            return (
              <Button
                variant="ghost"
                onClick={() =>
                  column.toggleSorting(column.getIsSorted() === "asc")
                }
                className="h-8 px-2"
              >
                {formattedLabel}
                <ArrowUpDown className="ml-2 h-4 w-4" />
              </Button>
            );
          },
          cell: ({ row }: { row: Row<TProcessed> }) => {
            const value = row.getValue(key);
            if (typeof value === "number" || Number.isFinite(Number(value))) {
              return (
                <div className="text-right font-mono">
                  {formatChartValue(Number(value), key)}
                </div>
              );
            }
            return <div>{String(value)}</div>;
          },
        };
      });

    if (enableRowSelection) {
      return [
        {
          id: "select",
          maxSize: CHECKBOX_COLUMN_WIDTH,
          minSize: CHECKBOX_COLUMN_WIDTH,
          header: ({ table }: { table: Table<TProcessed> }) => (
            <div className="flex items-center justify-center">
              <Checkbox
                checked={
                  table.getIsAllPageRowsSelected() ||
                  (table.getIsSomePageRowsSelected() && "indeterminate")
                }
                onCheckedChange={(value) =>
                  table.toggleAllPageRowsSelected(!!value)
                }
                aria-label="Select all"
              />
            </div>
          ),
          cell: ({ row }: { row: Row<TProcessed> }) => (
            <div className="flex items-center justify-center">
              <Checkbox
                checked={row.getIsSelected()}
                onCheckedChange={(value) => row.toggleSelected(!!value)}
                aria-label="Select row"
              />
            </div>
          ),
          enableSorting: false,
          enableHiding: false,
        },
        ...dataColumns,
      ];
    }

    return dataColumns;
  }, [hasData, processedData, enableRowSelection]);

  const table = useReactTable({
    data: processedData,
    columns: tableColumns,
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
    initialState: {
      pagination: {
        pageSize: pageSize,
      },
    },
  });

  if (loading) return <LoadingSkeleton />;
  if (error)
    return (
      <ErrorState error={typeof error === "string" ? error : "Unknown error"} />
    );

  if (!hasData) return <EmptyState />;

  return (
    <section className={className} aria-label={ariaLabel} data-testid={testId}>
      {children(table)}
    </section>
  );
}
