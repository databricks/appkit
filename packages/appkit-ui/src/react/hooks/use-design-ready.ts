import { useLayoutEffect } from "react";

/** CONTRACT: same key and shape as `window.__appkitDesign` in the design plugin's vite-plugin.ts. */
interface DesignHost {
  blockers: number;
  changed?: () => void;
}

/**
 * Holds back a page's readiness (`/design/__status`, `appkit:design-ready`,
 * `appkit:app-ready`) while `ready` is `false`, for content the page can't
 * detect on its own. Does nothing without the `design()` plugin's dev scripts.
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
