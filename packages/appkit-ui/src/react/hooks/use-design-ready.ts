import { useLayoutEffect } from "react";

/**
 * Readiness bookkeeping shared with the `/design` page entry served by the
 * `design()` plugin.
 *
 * CONTRACT: the design page entry and the app-ready script
 * (packages/appkit/src/plugins/design/vite-plugin.ts) create
 * `window.__appkitDesign` and read `blockers` / `changed`. Keep the key and
 * shape in sync with them.
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
 * to an embedding app builder (`appkit:design-ready` and `/design/__status` on
 * `/design`, `appkit:app-ready` on the app's own pages in development).
 *
 * Without the `design()` plugin's dev scripts (production, tests) it does
 * nothing.
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
