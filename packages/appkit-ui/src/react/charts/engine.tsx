import { createContext, type ReactNode, useContext } from "react";
import type { ChartEngine } from "./types";

// ============================================================================
// Chart Engine Context
// ============================================================================
//
// Lets an app pick the rendering engine for every chart at once — the "config
// var" for charts. Individual charts can still override via the `engine` prop.
//
// @example
// ```tsx
// // Render every chart in this subtree with Plotly:
// <ChartEngineProvider engine="plotly">
//   <Dashboard />
// </ChartEngineProvider>
//
// // …or override a single chart:
// <BarChart engine="plotly" queryKey="revenue" />
// ```

const ChartEngineContext = createContext<ChartEngine>("echarts");

export function ChartEngineProvider({
  engine,
  children,
}: {
  engine: ChartEngine;
  children: ReactNode;
}) {
  return (
    <ChartEngineContext.Provider value={engine}>
      {children}
    </ChartEngineContext.Provider>
  );
}

/** Returns the chart engine from the nearest provider (defaults to "echarts"). */
export function useChartEngine(): ChartEngine {
  return useContext(ChartEngineContext);
}
