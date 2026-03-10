import { useMemo } from "react";
import type { GenieStatementResponse } from "shared";
import { BaseChart } from "../charts/base";
import { ChartErrorBoundary } from "../charts/chart-error-boundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { inferChartType } from "./genie-chart-inference";
import { transformGenieData } from "./genie-query-transform";

const TABLE_ROW_LIMIT = 50;
const CHART_HEIGHT = 250;

interface GenieQueryVisualizationProps {
  /** Raw statement_response from the Genie API */
  data: GenieStatementResponse;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Renders a chart + data table for a Genie query result.
 *
 * - When a chart type can be inferred: shows Tabs with "Chart" (default) and "Table"
 * - When no chart fits: shows only the data table
 * - When data is empty/malformed: renders nothing
 */
export function GenieQueryVisualization({
  data,
  className,
}: GenieQueryVisualizationProps) {
  const transformed = useMemo(() => transformGenieData(data), [data]);
  const inference = useMemo(
    () =>
      transformed
        ? inferChartType(transformed.rows, transformed.columns)
        : null,
    [transformed],
  );

  if (!transformed || transformed.rows.length === 0) return null;

  const { rows, columns } = transformed;
  const truncated = rows.length > TABLE_ROW_LIMIT;
  const displayRows = truncated ? rows.slice(0, TABLE_ROW_LIMIT) : rows;

  const dataTable = (
    <div className="overflow-auto max-h-[300px]">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.name}>{col.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayRows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tabular data rows have no unique identifier
            <TableRow key={i}>
              {columns.map((col) => (
                <TableCell key={col.name}>
                  {row[col.name] != null ? String(row[col.name]) : ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {truncated && (
        <p className="text-xs text-muted-foreground px-2 py-1">
          Showing {TABLE_ROW_LIMIT} of {rows.length} rows
        </p>
      )}
    </div>
  );

  if (!inference) {
    return <div className={className}>{dataTable}</div>;
  }

  return (
    <Tabs defaultValue="chart" className={className}>
      <TabsList>
        <TabsTrigger value="chart">Chart</TabsTrigger>
        <TabsTrigger value="table">Table</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">
        <ChartErrorBoundary fallback={dataTable}>
          <BaseChart
            data={rows}
            chartType={inference.chartType}
            xKey={inference.xKey}
            yKey={inference.yKey}
            height={CHART_HEIGHT}
            showLegend={Array.isArray(inference.yKey)}
          />
        </ChartErrorBoundary>
      </TabsContent>
      <TabsContent value="table">{dataTable}</TabsContent>
    </Tabs>
  );
}
