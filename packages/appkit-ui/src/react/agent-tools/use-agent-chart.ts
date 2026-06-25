import { useEffect, useRef } from "react";
import { useOptionalAgentElementRegistry } from "./agent-tools-provider";
import { slugify } from "./verbs";

/** Minimal slice of the ECharts instance the chart capabilities need. */
export interface AgentChartInstance {
  dispatchAction: (payload: { type: string; [key: string]: unknown }) => void;
}

export interface UseAgentChartOptions {
  /** Stable id the agent targets. Falls back to a slug of the label/title. */
  agentId?: string;
  /** Human label (chart title) shown in the snapshot. */
  label?: string;
  /** Return the chart's normalized data series for `read_chart`. */
  getData: () => unknown;
  /** Return the chart's current config (title, axes, palette, …) for `read_chart`. */
  getConfig: () => unknown;
  /** Return the live ECharts instance for imperative actions (highlight). */
  getInstance: () => AgentChartInstance | null;
}

/**
 * Make a chart agent-addressable. Unlike `useAgentElement` (which drives a DOM
 * node via shared verbs), charts are stateless ECharts views with no DOM
 * affordances to click, so this registers a chart-specific capability set:
 *
 * - `read_chart` — returns the chart's config + normalized data series.
 * - `highlight_series` — emphasizes a named series via the ECharts instance.
 *
 * No-op without an `<AgentToolsProvider>` ancestor, so it is safe to bake into
 * the chart base unconditionally.
 */
export function useAgentChart(options: UseAgentChartOptions): void {
  const registry = useOptionalAgentElementRegistry();
  const latest = useRef(options);
  latest.current = options;

  // biome-ignore lint/correctness/useExhaustiveDependencies: registry/agentId carry the identity; the rest is read live via the ref
  useEffect(() => {
    if (!registry) return;
    const getLabel = () =>
      latest.current.label ?? latest.current.agentId ?? "chart";
    const baseId = latest.current.agentId ?? slugify(getLabel()) ?? "chart";

    return registry.register({
      baseId,
      role: "chart",
      getLabel,
      getState: () => ({ config: latest.current.getConfig() }),
      capabilities: {
        read_chart: {
          execute: () => ({
            config: latest.current.getConfig(),
            data: latest.current.getData(),
          }),
        },
        highlight_series: {
          execute: (args) => {
            const instance = latest.current.getInstance();
            if (!instance) {
              throw new Error("Chart is not ready (no ECharts instance).");
            }
            const series = String(args.series ?? "");
            // Clear any prior emphasis, then highlight the requested series.
            instance.dispatchAction({ type: "downplay" });
            instance.dispatchAction({ type: "highlight", seriesName: series });
            return { highlighted: series };
          },
        },
      },
    });
  }, [registry, options.agentId]);
}
