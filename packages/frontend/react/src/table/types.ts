import type { RowSelectionState, Table } from "@tanstack/react-table";

/**
 * Props for the TableWrapper component
 * @template TRaw - The raw data type returned by the analytics query
 * @template TProcessed - The processed data type after transformation
 */
export interface TableWrapperProps<TRaw = any, TProcessed = any> {
  /** The query key to fetch the data */
  queryKey: string;
  /** The parameters to pass to the query */
  parameters: Record<string, any>;
  /** Optional function to transform raw data before creating table */
  transformer?: (data: TRaw[]) => TProcessed[];
  /** Render function that receives the TanStack Table instance */
  children: (data: Table<TProcessed>) => React.ReactNode;
  /** Optional CSS class name for the wrapper */
  className?: string;
  /** Optional accessibility label for the wrapper */
  ariaLabel?: string;
  /** Optional test ID for the wrapper */
  testId?: string;
  /** Enable row selection with checkboxes */
  enableRowSelection?: boolean;
  /** Callback function to handle row selection changes */
  onRowSelectionChange?: (rowSelection: RowSelectionState) => void;
  /** Number of rows to display per page */
  pageSize?: number;
}

/** Props for the DataTable component */
export interface DataTableProps {
  /** The query key to fetch the data */
  queryKey: string;
  /** The parameters to pass to the query */
  parameters: Record<string, any>;
  /** The column to filter by */
  filterColumn?: string;
  /** Optional placeholder for the filter input */
  filterPlaceholder?: string;
  /** Optional function to transform data before creating table */
  transform?: (data: any[]) => any[];
  /** Optional labels for the DataTable component */
  labels?: DataTableLabels;
  /** Optional accessibility label for the DataTable component */
  ariaLabel?: string;
  /** Optional test ID for the DataTable component */
  testId?: string;
  /** Optional CSS class name for the DataTable component */
  className?: string;
  /** Enable row selection with checkboxes */
  enableRowSelection?: boolean;
  /** Callback function to handle row selection changes */
  onRowSelectionChange?: (rowSelection: RowSelectionState) => void;
  /** Optional children for full control mode */
  children?: (table: Table<any>) => React.ReactNode;
  /** Number of rows to display per page */
  pageSize?: number;
  /** Options for the page size selector */
  pageSizeOptions?: number[];
}

/** Labels for the DataTable component */
export interface DataTableLabels {
  /** The button text for the columns menu */
  columnsButton?: string;
  /** The text for the no results message */
  noResults?: string;
  /** The text for the rows found message */
  rowsFound?: string;
  /** The text for the previous button */
  previousButton?: string;
  /** The text for the next button */
  nextButton?: string;
  /** The text for the rows per page label */
  rowsPerPage?: string;
  /** The text for showing rows (e.g., "Showing ${from} to ${to} of ${total}") */
  showing?: string;
}
