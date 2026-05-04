import type { ReactElement, ReactNode } from "react";
import type { DatabaseEntityKey } from "@/js";
import { formatFieldLabel } from "../lib/format";
import { cn } from "../lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import type { RowOf, ViewEntityProps } from "./types";
import { useEntityRows } from "./use-entity-rows";

// ---------------------------------------------------------------------------
// Shared state components (loading / error / empty)
// ---------------------------------------------------------------------------

export function EntityLoading() {
  return (
    <div className="rounded-md border overflow-hidden">
      <div className="border-b bg-secondary p-4">
        <div className="flex gap-4">
          <div className="h-6 bg-muted rounded animate-pulse flex-1" />
          <div className="h-6 bg-muted rounded animate-pulse flex-1" />
          <div className="h-6 bg-muted rounded animate-pulse flex-1" />
        </div>
      </div>
      {[0, 1, 2, 3].map((n) => (
        <div
          key={`entity-loading-${n}`}
          className="border-b p-4 last:border-b-0"
        >
          <div className="flex gap-4">
            <div className="h-5 bg-muted rounded animate-pulse flex-1" />
            <div className="h-5 bg-muted rounded animate-pulse flex-1" />
            <div className="h-5 bg-muted rounded animate-pulse flex-1" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EntityError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      Error loading entity: {message}
    </div>
  );
}

function EntityEmpty({ label }: { label?: string }) {
  return (
    <div className="rounded-md border p-8 text-center">
      <p className="text-sm text-muted-foreground">
        {label ?? "No rows to display."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewEntity
// ---------------------------------------------------------------------------

/**
 * Read-only, zero-config table for any registered entity.
 *
 * Fetches rows via `db.<entity>.where(...).order(...).limit(...)` and infers
 * columns dynamically from the returned data — no metadata endpoint, no
 * registry, no build-time column file needed.
 *
 * @example Minimal
 * ```tsx
 * <ViewEntity entity="cases" />
 * ```
 *
 * @example Filtered + projected
 * ```tsx
 * <ViewEntity
 *   entity="cases"
 *   where={{ status: "New" }}
 *   order={{ created_at: "desc" }}
 *   select={["case_id", "status", "risk_level"]}
 *   limit={100}
 * />
 * ```
 */
export function ViewEntity<E extends DatabaseEntityKey>(
  props: ViewEntityProps<E>,
): ReactElement {
  const {
    entity,
    variant = "table",
    where,
    order,
    limit,
    select,
    fields,
    ariaLabel,
    testId,
    className,
    onRowClick,
  } = props;

  const { rows, loading, error } = useEntityRows(entity, {
    where,
    order,
    limit,
    select,
  });

  if (variant !== "table") {
    return (
      <EntityError
        message={`Unknown ViewEntity variant "${String(variant)}".`}
      />
    );
  }

  if (error) return <EntityError message={error} />;
  if (loading && rows === null) return <EntityLoading />;
  if (!rows || rows.length === 0) return <EntityEmpty />;

  // Infer columns from the first row's keys — no metadata needed.
  const allColumns = Object.keys(rows[0] as Record<string, unknown>);
  const visibleColumns = resolveVisibleColumns(allColumns, fields, select);

  return (
    <section
      className={cn("w-full min-w-0", className)}
      aria-label={ariaLabel ?? `${entity} rows`}
      data-testid={testId}
    >
      <div className="max-w-full overflow-x-auto rounded-md border bg-card">
        <Table className="w-max min-w-full">
          <TableHeader>
            <TableRow>
              {visibleColumns.map((col) => (
                <TableHead key={col} className="px-3 py-2.5">
                  {formatFieldLabel(col)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow
                key={stableRowKey(row as Record<string, unknown>, rowIndex)}
                className={
                  onRowClick
                    ? "cursor-pointer hover:bg-muted/50 data-[state=selected]:bg-muted"
                    : undefined
                }
                onClick={
                  onRowClick ? () => onRowClick(row as RowOf<E>) : undefined
                }
              >
                {visibleColumns.map((col) => (
                  <TableCell key={col} className="px-3 py-2.5 align-top">
                    {renderCell((row as Record<string, unknown>)[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * Pick which columns to show. Priority: explicit `fields`, then `select`
 * (what was fetched), then every key from the data.
 */
function resolveVisibleColumns(
  allColumns: string[],
  fields?: readonly string[],
  select?: readonly string[],
): string[] {
  if (fields && fields.length > 0) {
    const available = new Set(allColumns);
    return fields.filter((f) => available.has(f));
  }
  if (select && select.length > 0) {
    const available = new Set(allColumns);
    return select.filter((f) => available.has(f));
  }
  return allColumns;
}

function stableRowKey(
  row: Record<string, unknown>,
  fallback: number,
): string | number {
  const keys = Object.keys(row);
  const idKey =
    keys.find((k) => k === "id") ??
    keys.find((k) => k.endsWith("_id")) ??
    keys.find((k) => k.endsWith("Id"));
  if (idKey) {
    const v = row[idKey];
    if (typeof v === "string" || typeof v === "number") return v;
  }
  return fallback;
}

/** Render a cell value with sensible defaults inferred from the value itself. */
function renderCell(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return (
      <span className="font-mono tabular-nums">
        {value.toLocaleString("en-US")}
      </span>
    );
  }
  if (typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      return (
        <code className="text-xs">
          {serialized.length > 60 ? `${serialized.slice(0, 60)}…` : serialized}
        </code>
      );
    } catch {
      return String(value);
    }
  }
  // Try to detect ISO date strings
  if (typeof value === "string" && isISODateString(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d);
    }
  }
  return String(value);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]/;
function isISODateString(value: string): boolean {
  return ISO_DATE_RE.test(value);
}
