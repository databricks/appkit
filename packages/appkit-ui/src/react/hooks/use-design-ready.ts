import { useLayoutEffect } from "react";

/**
 * Readiness bookkeeping shared with the `/design` page entry served by the
 * `design()` plugin.
 *
 * CONTRACT: the entry (packages/appkit/src/plugins/design/vite-plugin.ts)
 * creates `window.__appkitDesign` and reads `blockers` / `changed`. Keep the
 * key and shape in sync with it.
 */
interface DesignHost {
  blockers: number;
  changed?: () => void;
}

/**
 * Holds back a `/design` page's readiness while `ready` is `false`, for
 * content the page can't detect on its own: data that loads after a delay,
 * a chart that draws asynchronously, an animation that must finish first.
 * While any mounted component passes `false`, the page isn't reported ready
 * to an embedding app builder (`appkit:design-ready`, `/design/__status`).
 *
 * Outside `/design` (the real app, tests) it does nothing.
 *
 * @example
 * ```tsx
 * function TripsChart() {
 *   const { data, loading } = useAnalyticsQuery("trips_per_day", {});
 *   useDesignReady(!loading && data != null);
 *   return <LineChart data={data ?? []} />;
 * }
 * ```
 */
export function useDesignReady(ready = true): void {
  useLayoutEffect(() => {
    if (ready) return;
    const host = (window as { __appkitDesign?: DesignHost }).__appkitDesign;
    if (!host) return;
    host.blockers++;
    return () => {
      host.blockers--;
      host.changed?.();
    };
  }, [ready]);
}
