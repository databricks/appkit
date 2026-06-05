import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type ToasterProps, toast } from "sonner";
import {
  type AggregatedResourceStatus,
  type ResourceStatus,
  useResourceStatus,
} from "./hooks/use-resource-status";
import { Toaster } from "./ui/sonner";

/**
 * How often the indicator recomputes the displayed elapsed time. The store
 * is event-driven and only notifies on `publish`/`unpublish`; the backend
 * de-duplicates equal successive states, so during a long cold start the
 * store may go quiet for tens of seconds. The indicator drives its own
 * ~1Hz tick so the toast description advances visibly even when no new
 * status events arrive.
 */
const ELAPSED_TICK_MS = 1000;

/**
 * Per-kind UI overrides. Indicator authors register copy + an optional icon
 * for each resource kind they care about; the indicator falls back to a
 * generic "{kind} not ready" message for kinds that aren't registered.
 */
export interface ResourceKindRenderer {
  /** Title shown when this kind is the worst pending status. */
  title: (status: ResourceStatus) => string;
  /** Body copy shown when this kind is the worst pending status. */
  description: (
    status: ResourceStatus,
    aggregate: AggregatedResourceStatus,
  ) => string;
  /** Override the icon (defaults to sonner's built-in loading/error icon). */
  icon?: LucideIcon;
}

/** Options shared by {@link ResourceStatusIndicator} and {@link useResourceStatusToaster}. */
export interface ResourceStatusToasterOptions {
  /** Restrict to a single resource kind. Otherwise shows the worst across all kinds. */
  kind?: string;
  /** Per-kind copy + icon overrides. */
  renderers?: Record<string, ResourceKindRenderer>;
  /** Class name applied to the indicator's toast (not the Toaster wrapper). */
  toastClassName?: string;
  /**
   * Full custom render override. Receives the aggregate (already non-empty)
   * and returns the JSX rendered inside a sonner `toast.custom`. Use this
   * when the default loading/error toast doesn't fit your needs.
   */
  render?: (aggregate: AggregatedResourceStatus) => React.ReactNode;
}

const DEFAULT_KIND_RENDERERS: Record<string, ResourceKindRenderer> = {
  warehouse: {
    title: (s) =>
      s.severity === "error"
        ? "SQL warehouse unavailable"
        : "SQL warehouse warming up",
    description: (s, agg) => {
      if (s.severity === "error") {
        return (
          s.summary ??
          "The configured SQL warehouse is unavailable. Update DATABRICKS_WAREHOUSE_ID and reload."
        );
      }
      const labels = agg.affectedLabels.length;
      if (labels === 0) {
        return `Waiting for the warehouse to reach RUNNING · ${formatElapsed(agg.elapsedMs)}`;
      }
      return `${labels} ${labels === 1 ? "query" : "queries"} waiting · ${formatElapsed(agg.elapsedMs)}`;
    },
  },
};

/**
 * Subscribes to the nearest {@link ResourceStatusProvider} and drives a
 * sonner toast that mirrors the worst pending status. The hook does not
 * render anything — supply your own `<Toaster />` somewhere in the tree.
 *
 * Most apps should prefer {@link ResourceStatusIndicator}, which mounts a
 * `<Toaster />` for you. Use this hook only when you already have a
 * `<Toaster />` for unrelated app toasts and want resource-status toasts
 * to share it.
 *
 * @example
 * ```tsx
 * function App() {
 *   useResourceStatusToaster();
 *   return (
 *     <>
 *       <Toaster position="top-right" />
 *       <Routes />
 *     </>
 *   );
 * }
 * ```
 */
export function useResourceStatusToaster(
  options: ResourceStatusToasterOptions = {},
): void {
  const { kind, renderers, toastClassName, render } = options;
  const aggregate = useResourceStatus(kind ? { kind } : undefined);
  const worst = aggregate.worst;
  // Scope toast ids to this hook instance + the worst kind. Per-instance
  // scoping means two hook callers in the same tree (e.g. one global, one
  // kind-filtered) don't fight for the same id; per-kind scoping means a
  // warehouse error replacing a lakebase wait dismisses-and-recreates rather
  // than morphing one toast into another (which sonner can't do cleanly
  // across types — `jsx`/`description` from the prior call leak through).
  const instanceId = useId();

  // Wall-clock tick that re-renders this component once per second while a
  // wait is active. The store is event-driven, so without this tick the
  // displayed `elapsedMs` would freeze between status emissions.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!worst) return;
    const id = setInterval(() => forceTick((n) => n + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [worst]);

  // Track the most recently shown toast id so we can dismiss it when the
  // worst kind changes (e.g. warehouse error supersedes a lakebase wait)
  // or when the aggregate clears entirely.
  const liveIdRef = useRef<string | null>(null);

  // Drive sonner imperatively. This effect runs on every render where
  // `worst` exists (intentionally no deps array): cheap because sonner
  // dedups updates against the same id and just patches the existing
  // toast in place — no re-animation, no flicker.
  useEffect(() => {
    if (!worst) {
      if (liveIdRef.current) {
        toast.dismiss(liveIdRef.current);
        liveIdRef.current = null;
      }
      return;
    }

    // Recompute elapsed locally so the renderer sees the live value
    // (the snapshot's `elapsedMs` only refreshes on store events).
    const liveAggregate: AggregatedResourceStatus = {
      ...aggregate,
      elapsedMs: Math.max(0, Date.now() - worst.startedAt),
    };

    const nextId = `appkit-resource:${instanceId}:${worst.kind}`;
    if (liveIdRef.current && liveIdRef.current !== nextId) {
      toast.dismiss(liveIdRef.current);
    }
    liveIdRef.current = nextId;

    if (render) {
      const node = render(liveAggregate);
      toast.custom(() => <>{node}</>, {
        id: nextId,
        duration: Number.POSITIVE_INFINITY,
        className: toastClassName,
      });
      return;
    }

    const merged = { ...DEFAULT_KIND_RENDERERS, ...renderers };
    const renderer = merged[worst.kind];
    const title = renderer?.title(worst) ?? defaultTitle(worst);
    const description =
      renderer?.description(worst, liveAggregate) ?? defaultDescription(worst);
    const Icon = renderer?.icon;
    const opts = {
      id: nextId,
      description,
      duration: Number.POSITIVE_INFINITY,
      className: toastClassName,
      ...(Icon ? { icon: <Icon className="size-4" /> } : {}),
    };

    if (worst.severity === "error") {
      toast.error(title, opts);
    } else {
      toast.loading(title, opts);
    }
  });

  // Dismiss any live toast on unmount so the floating UI doesn't outlive
  // the mount point (e.g. on route changes that swap the indicator out).
  useEffect(() => {
    return () => {
      if (liveIdRef.current) {
        toast.dismiss(liveIdRef.current);
        liveIdRef.current = null;
      }
    };
  }, []);
}

export interface ResourceStatusIndicatorProps
  extends ResourceStatusToasterOptions,
    Omit<ToasterProps, "className"> {
  /** Class name applied to the Toaster wrapper. */
  className?: string;
}

/**
 * Drop-in indicator that mounts a `<Toaster />` and surfaces the worst
 * pending {@link ResourceStatus} across every plugin/component publishing
 * into the nearest {@link ResourceStatusProvider} as a sonner toast.
 *
 * Renders nothing while the aggregate is empty (i.e. all resources ready).
 * Otherwise drives a single sticky `toast.loading` (or `toast.error` for
 * error severity) keyed by the worst kind, so only one indicator toast is
 * ever on screen.
 *
 * Forwards `Toaster` props (`position` defaults to `top-right`, plus
 * `theme`, `richColors`, …) so you don't need to mount sonner's
 * `<Toaster />` separately. Apps that already have their own `<Toaster />`
 * should drop this component and call {@link useResourceStatusToaster}
 * instead.
 *
 * @example
 * ```tsx
 * <ResourceStatusProvider>
 *   <ResourceStatusIndicator />
 *   <App />
 * </ResourceStatusProvider>
 * ```
 *
 * @example Custom render
 * ```tsx
 * <ResourceStatusIndicator
 *   render={(agg) => (
 *     <div className="my-card">
 *       {agg.worst?.kind} {agg.worst?.state.toLowerCase()}
 *     </div>
 *   )}
 * />
 * ```
 */
export function ResourceStatusIndicator({
  kind,
  renderers,
  toastClassName,
  render,
  position = "top-right",
  ...toasterProps
}: ResourceStatusIndicatorProps = {}) {
  useResourceStatusToaster({ kind, renderers, toastClassName, render });
  return <Toaster position={position} {...toasterProps} />;
}

function defaultTitle(status: ResourceStatus): string {
  switch (status.severity) {
    case "error":
      return `${humanizeKind(status.kind)} unavailable`;
    case "warning":
      return `${humanizeKind(status.kind)} degraded`;
    default:
      return `${humanizeKind(status.kind)} not ready`;
  }
}

function defaultDescription(status: ResourceStatus): string {
  if (status.summary) return status.summary;
  return `Current state: ${status.state}.`;
}

function humanizeKind(kind: string): string {
  if (!kind) return "Resource";
  return kind
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
