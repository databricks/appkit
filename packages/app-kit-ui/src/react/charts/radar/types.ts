import type { ChartConfig } from "../../ui/chart";

/** Props for the RadarChart component */
export interface RadarChartProps {
  /** Analytics query key registered with analytics plugin */
  queryKey: string;
  /** Query Parameters passed to the analytics endpoint */
  parameters: Record<string, any>;

  /** Transform raw data before rendering */
  transformer?: (data: any[]) => any[];

  /** Chart configuration overrides */
  chartConfig?: ChartConfig;

  /** Custom Recharts component for full control mode */
  children?: React.ReactNode;

  /** Accessibility label for screen readers */
  ariaLabel?: string;
  /** Test ID for automated testing */
  testId?: string;

  /** Additional CSS classes */
  className?: string;
  /** Chart height @default 300px */
  height?: string;

  /** Opacity of filled area @default 0.6 */
  fillOpacity?: number;

  /** Show dots on data points @default false */
  showDots?: boolean;

  /** Field to use for angle axis (auto-detected if not provided) */
  angleField?: string;
}
