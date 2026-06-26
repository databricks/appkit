import { useEffect, useRef } from "react";
import { useOptionalAgentElementRegistry } from "./agent-tools-provider";
import { slugify } from "./verbs";

export interface UseAgentChartOptions {
  /** Stable id the agent targets. Falls back to a slug of the label/title. */
  agentId?: string;
  /** Human label (chart title) shown in the snapshot. */
  label?: string;
  /** Return the chart's normalized data series for `read_chart`. */
  getData: () => unknown;
  /** Return the chart's current config (title, axes, palette, …) for `read_chart`. */
  getConfig: () => unknown;
  /** Return the chart's current (rendered) series names for `highlight_series`. */
  getSeriesNames: () => string[];
  /** Emphasize a series (dim the rest), or clear with `null`. */
  setHighlight: (seriesName: string | null) => void;
}

/**
 * Make a chart agent-addressable. Unlike `useAgentElement` (which drives a DOM
 * node via shared verbs), charts are stateless ECharts views with no DOM
 * affordances to click, so this registers a chart-specific capability set:
 *
 * - `read_chart` — returns the chart's config + normalized data series.
 * - `highlight_series` — emphasizes a named series (dims the others) by
 *   flipping the chart's React state, which is reliable and persistent
 *   (no imperative ECharts instance, which has init-timing traps).
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
            const requested = String(args.series ?? "").trim();
            const names = latest.current.getSeriesNames();
            // Resolve against the chart's actual series names so the agent can
            // pass "Profit" and match "profit" (ECharts is case-sensitive).
            const want = requested.toLowerCase();
            const matched =
              names.find((n) => n.toLowerCase() === want) ??
              names.find((n) => n.toLowerCase().includes(want));
            if (!matched) {
              throw new Error(
                `Series "${requested}" not found. Available series: ${names.join(", ") || "(none)"}.`,
              );
            }
            latest.current.setHighlight(matched);
            return {
              highlighted: matched,
              dimmed: names.filter((n) => n !== matched),
            };
          },
        },
      },
    });
  }, [registry, options.agentId]);
}
