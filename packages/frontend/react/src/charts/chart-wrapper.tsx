import { useChartData } from "../hooks/use-chart-data";
import { ChartErrorBoundary } from "./chart-error-boundary";
import { EmptyState } from "./empty";
import { ErrorState } from "./error";
import { LoadingSkeleton } from "./loading";

/**
 * Props for the ChartWrapper component
 * @template TRaw - The raw data type return by the analytics query
 * @template TProcessed - The processed data type
 * @param queryKey - The query key to fetch the data
 * @param parameters - The parameters to pass to the query
 * @param transformer - A custom transformer function to transform the data
 * @param children - The children to render
 * @param height - The height of the chart
 * @param className - The class name to apply to the chart
 */
export interface ChartWrapperProps<TRaw = any, TProcessed = any> {
  queryKey: string;
  parameters: Record<string, any>;
  transformer?: (data: TRaw[]) => TProcessed[];
  children: (data: TProcessed[]) => React.ReactNode;
  height?: string;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}

/**
 * Wrapper component for charts with automatic data fetching and state management
 * @template TRaw - The raw data type return by the analytics query
 * @template TProcessed - The processed data type
 * @param props - The props for the ChartWrapper component
 * @param props.queryKey - The query key to fetch the data
 * @param props.parameters - The parameters to pass to the query
 * @param props.transformer - A custom transformer function to transform the data
 * @param props.children - The children to render
 * @param props.height - The height of the chart
 * @param props.className - The class name to apply to the chart
 * @param props.ariaLabel - The accessibility label for the chart
 * @param props.testId - The test ID for the chart
 * @returns - The rendered chart component with error boundary
 */
export function ChartWrapper<TRaw = any, TProcessed = any>(
  props: ChartWrapperProps<TRaw, TProcessed>,
) {
  const {
    queryKey,
    parameters,
    transformer,
    children,
    height = "300px",
    className,
    ariaLabel,
    testId,
  } = props;

  const { data, loading, error, isEmpty } = useChartData<TRaw, TProcessed>({
    queryKey,
    parameters,
    transformer,
  });

  if (loading) return <LoadingSkeleton height={height} />;
  if (error) return <ErrorState error={error} />;
  if (isEmpty) return <EmptyState />;

  return (
    <ChartErrorBoundary
      fallback={<ErrorState error="Failed to load chart data" />}
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
