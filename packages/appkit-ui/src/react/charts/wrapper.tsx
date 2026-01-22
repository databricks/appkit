import type { ReactNode } from "react";
import { useChartData } from "../hooks/use-chart-data";
import { ChartErrorBoundary } from "./chart-error-boundary";
import { EmptyState } from "./empty";
import { ErrorState } from "./error";
import { LoadingSkeleton } from "./loading";
import type { ChartData, DataFormat } from "./types";
import { isArrowTable } from "./types";

// ============================================================================
// Props Types
// ============================================================================

interface ChartWrapperQueryProps {
  /** Analytics query key */
  queryKey: string;
  /** Query parameters */
  parameters?: Record<string, unknown>;
  /** Data format preference */
  format?: DataFormat;
  /** Transform data after fetching */
  transformer?: <T>(data: T) => T;
  /** Direct data - not used in query mode */
  data?: never;
}

interface ChartWrapperDataProps {
  /** Direct data (Arrow Table or JSON array) */
  data: ChartData;
  /** Not used in data mode */
  queryKey?: never;
  parameters?: never;
  format?: never;
  transformer?: never;
}

interface CommonProps {
  /** Chart height in pixels */
  height?: number;
  /** Additional CSS classes */
  className?: string;
  /** Accessibility label */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;
  /** Render function receiving the chart data */
  children: (data: ChartData) => ReactNode;
}

export type ChartWrapperProps = CommonProps &
  (ChartWrapperQueryProps | ChartWrapperDataProps);

// ============================================================================
// Query Mode Content
// ============================================================================

function QueryModeContent({
  queryKey,
  parameters,
  format,
  transformer,
  height,
  className,
  ariaLabel,
  testId,
  children,
}: CommonProps & ChartWrapperQueryProps) {
  const { data, loading, error, isEmpty } = useChartData({
    queryKey,
    parameters,
    format,
    transformer,
  });

  if (loading) return <LoadingSkeleton height={height ?? 300} />;
  if (error) return <ErrorState error={error} />;
  if (isEmpty || !data) return <EmptyState />;

  return (
    <ChartErrorBoundary
      fallback={<ErrorState error="Failed to render chart" />}
    >
      <div
        className={className}
        style={{ height }}
        aria-label={ariaLabel}
        data-testid={testId}
        role="img"
      >
        {children(data)}
      </div>
    </ChartErrorBoundary>
  );
}

// ============================================================================
// Data Mode Content
// ============================================================================

function DataModeContent({
  data,
  height,
  className,
  ariaLabel,
  testId,
  children,
}: CommonProps & ChartWrapperDataProps) {
  const isEmpty = isArrowTable(data)
    ? data.numRows === 0
    : !Array.isArray(data) || data.length === 0;

  if (isEmpty) return <EmptyState />;

  return (
    <ChartErrorBoundary
      fallback={<ErrorState error="Failed to render chart" />}
    >
      <div
        className={className}
        style={{ height }}
        aria-label={ariaLabel}
        data-testid={testId}
        role="img"
      >
        {children(data)}
      </div>
    </ChartErrorBoundary>
  );
}

// ============================================================================
// Main Wrapper Component
// ============================================================================

/**
 * Wrapper component for charts.
 * Handles data fetching (query mode) or direct data injection (data mode).
 *
 * @example Query mode - fetches data from analytics endpoint
 * ```tsx
 * <ChartWrapper
 *   queryKey="spend_data"
 *   parameters={{ limit: 100 }}
 *   format="auto"
 * >
 *   {(data) => <MyChart data={data} />}
 * </ChartWrapper>
 * ```
 *
 * @example Data mode - uses provided data directly
 * ```tsx
 * <ChartWrapper data={myArrowTable}>
 *   {(data) => <MyChart data={data} />}
 * </ChartWrapper>
 * ```
 */
export function ChartWrapper(props: ChartWrapperProps) {
  const { height = 300, className, ariaLabel, testId, children } = props;

  // Data mode: use provided data directly
  if ("data" in props && props.data !== undefined) {
    return (
      <DataModeContent
        data={props.data}
        height={height}
        className={className}
        ariaLabel={ariaLabel}
        testId={testId}
      >
        {children}
      </DataModeContent>
    );
  }

  // Query mode: fetch data from analytics endpoint
  if ("queryKey" in props && props.queryKey !== undefined) {
    return (
      <QueryModeContent
        queryKey={props.queryKey}
        parameters={props.parameters}
        format={props.format}
        transformer={props.transformer}
        height={height}
        className={className}
        ariaLabel={ariaLabel}
        testId={testId}
      >
        {children}
      </QueryModeContent>
    );
  }

  // Should never reach here due to TypeScript, but safety fallback
  return <ErrorState error="Chart requires either 'queryKey' or 'data' prop" />;
}
