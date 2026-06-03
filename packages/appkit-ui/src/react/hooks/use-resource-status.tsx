import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

const NOOP_SUBSCRIBE: (listener: () => void) => () => void = () => () => {};

/**
 * Severity bucket used to aggregate readiness across resource kinds.
 *
 * Ordering, worst-first, is `error > warning > pending`. Anything other than
 * absence-of-status is "the user is waiting on something" — so callers should
 * not publish a status for healthy/ready resources (they should `unpublish`
 * instead).
 */
export type ResourceSeverity = "pending" | "warning" | "error";

/**
 * A snapshot of the readiness of a single resource (e.g. a SQL warehouse, a
 * Lakebase Postgres connection, a model-serving endpoint). Plugins publish
 * one of these whenever a user-visible cold start, warm-up, or unavailability
 * occurs, so the host app can surface a single global affordance instead of
 * each plugin painting its own indicator.
 */
export interface ResourceStatus {
  /**
   * Resource family this status belongs to. Conventionally lowercase-kebab
   * (`"warehouse"`, `"lakebase"`, `"model-endpoint"`, …). Consumers can
   * filter the aggregate to a single kind.
   */
  kind: string;
  /**
   * Resource-specific raw state — `"STARTING"`, `"DELETED"`, `"COLD_START"`,
   * etc. Opaque to the aggregator; consumers cast it to a kind-specific union
   * when rendering kind-specific copy.
   */
  state: string;
  /**
   * Cross-kind severity used to compute the "worst" status across all
   * publishers. `pending` → user is waiting; `warning` → degraded but
   * usable; `error` → resource is unusable and a config change is required.
   */
  severity: ResourceSeverity;
  /** Optional human-readable summary forwarded to the indicator UI. */
  summary?: string;
  /**
   * Epoch ms when the publisher started waiting for this resource. The
   * aggregator surfaces `elapsedMs` derived from this value.
   */
  startedAt: number;
}

/**
 * Aggregate view of every active publisher under a {@link ResourceStatusProvider}.
 *
 * Returned by {@link useResourceStatus}.
 */
export interface AggregatedResourceStatus {
  /** Highest-severity status across all publishers, or `null` when nothing is pending. */
  worst: ResourceStatus | null;
  /** Worst status per `kind` — useful for showing per-resource-family copy. */
  byKind: Record<string, ResourceStatus>;
  /** De-duped, sorted labels of every publisher with a non-null status. */
  affectedLabels: string[];
  /** Total number of currently-registered publishers (including those whose status is `null`). */
  activeCount: number;
  /** Milliseconds elapsed since the worst entry's `startedAt`. `0` when nothing is pending. */
  elapsedMs: number;
  /**
   * Monotonic counter bumped on every `publish`/`unpublish`. Lets
   * {@link useResourceStatus}'s kind-filter consumers re-derive when
   * entries change in ways that don't move any of the aggregated fields
   * above (e.g. a status-less slot updating its `kindHint`).
   */
  version: number;
}

/** Optional filter for {@link useResourceStatus}. */
export interface ResourceStatusFilter {
  /** Restrict the aggregate to a single resource kind. */
  kind?: string;
}

const SEVERITY_RANK: Record<ResourceSeverity, number> = {
  error: 0,
  warning: 1,
  pending: 2,
};

/**
 * Internal registry record. `kindHint` lets adapter hooks (e.g. the analytics
 * warehouse adapter) keep slots associated with their resource kind even
 * before the first status payload arrives — so kind-scoped views can count
 * "registered but not yet reporting" publishers correctly.
 */
interface RegistryEntry {
  label: string;
  status: ResourceStatus | null;
  kindHint?: string;
}

const EMPTY_SNAPSHOT: AggregatedResourceStatus = {
  worst: null,
  byKind: {},
  affectedLabels: [],
  activeCount: 0,
  elapsedMs: 0,
  version: 0,
};

const GET_EMPTY_SNAPSHOT = (): AggregatedResourceStatus => EMPTY_SNAPSHOT;

/**
 * Internal store: a flat map from a stable per-publisher id to its latest
 * status. We use `useSyncExternalStore` so subscribers re-render only when
 * the aggregate they actually consume changes.
 */
class ResourceStatusStore {
  private entries = new Map<string, RegistryEntry>();
  private listeners = new Set<() => void>();
  private snapshot: AggregatedResourceStatus = EMPTY_SNAPSHOT;
  private version = 0;

  publish(
    id: string,
    label: string,
    status: ResourceStatus | null,
    kindHint?: string,
  ): void {
    this.entries.set(id, { label, status, kindHint });
    this.version += 1;
    this.recompute();
  }

  unpublish(id: string): void {
    if (this.entries.delete(id)) {
      this.version += 1;
      this.recompute();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AggregatedResourceStatus => this.snapshot;

  /** Used by {@link useResourceStatus}'s kind filter to count slots that
   * registered with a matching `kindHint` but haven't reported a status
   * yet (so the filtered aggregate can show "N waiting" before the first
   * payload arrives). */
  getEntries(): Map<string, RegistryEntry> {
    return this.entries;
  }

  private recompute(): void {
    const next = { ...aggregate(this.entries), version: this.version };
    if (snapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

function isWorse(a: ResourceStatus, b: ResourceStatus): boolean {
  const aRank = SEVERITY_RANK[a.severity];
  const bRank = SEVERITY_RANK[b.severity];
  if (aRank !== bRank) return aRank < bRank;
  // Same severity → the longer-pending entry is "worse" from a UX standpoint.
  return a.startedAt < b.startedAt;
}

/**
 * Pure derivation of the aggregate fields from `entries`. The store wraps
 * the result with the monotonic `version` counter to produce the full
 * {@link AggregatedResourceStatus} snapshot.
 */
function aggregate(
  entries: Map<string, RegistryEntry>,
): Omit<AggregatedResourceStatus, "version"> {
  if (entries.size === 0) {
    const { version: _, ...rest } = EMPTY_SNAPSHOT;
    return rest;
  }

  let worst: ResourceStatus | null = null;
  const byKind: Record<string, ResourceStatus> = {};
  const affectedLabels = new Set<string>();

  for (const entry of entries.values()) {
    const status = entry.status;
    if (!status) continue;
    affectedLabels.add(entry.label);
    const existing = byKind[status.kind];
    if (!existing || isWorse(status, existing)) {
      byKind[status.kind] = status;
    }
    if (!worst || isWorse(status, worst)) {
      worst = status;
    }
  }

  return {
    worst,
    byKind,
    affectedLabels: [...affectedLabels].sort(),
    activeCount: entries.size,
    elapsedMs: worst ? Math.max(0, Date.now() - worst.startedAt) : 0,
  };
}

function recordsEqual(
  a: Record<string, ResourceStatus>,
  b: Record<string, ResourceStatus>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function snapshotsEqual(
  a: AggregatedResourceStatus,
  b: AggregatedResourceStatus,
): boolean {
  if (a.version !== b.version) return false;
  if (a.worst !== b.worst) return false;
  if (a.activeCount !== b.activeCount) return false;
  if (a.elapsedMs !== b.elapsedMs) return false;
  if (a.affectedLabels.length !== b.affectedLabels.length) return false;
  for (let i = 0; i < a.affectedLabels.length; i++) {
    if (a.affectedLabels[i] !== b.affectedLabels[i]) return false;
  }
  return recordsEqual(a.byKind, b.byKind);
}

interface ResourceStatusContextValue {
  store: ResourceStatusStore;
}

const ResourceStatusContext = createContext<ResourceStatusContextValue | null>(
  null,
);

function useResourceStatusContext(): ResourceStatusContextValue | null {
  return useContext(ResourceStatusContext);
}

export interface ResourceStatusProviderProps {
  children: ReactNode;
}

/**
 * Mount once near the root of your app to enable a global, cross-plugin
 * readiness aggregate. Plugins (or your own code) publish {@link ResourceStatus}
 * snapshots while a resource is warming up / unavailable; the provider
 * deduplicates them, picks the worst, and exposes the result via
 * {@link useResourceStatus} so a single indicator can surface it.
 *
 * Without a provider, both `useResourceStatus` and `useResourceStatusPublisher`
 * fall back to no-ops, so plugins are safe to call them unconditionally.
 *
 * @example
 * ```tsx
 * <ResourceStatusProvider>
 *   <ResourceStatusIndicator />
 *   <App />
 * </ResourceStatusProvider>
 * ```
 */
export function ResourceStatusProvider({
  children,
}: ResourceStatusProviderProps) {
  const storeRef = useRef<ResourceStatusStore | null>(null);
  if (storeRef.current === null) storeRef.current = new ResourceStatusStore();

  const value = useMemo(
    () => ({ store: storeRef.current as ResourceStatusStore }),
    [],
  );

  return (
    <ResourceStatusContext.Provider value={value}>
      {children}
    </ResourceStatusContext.Provider>
  );
}

/**
 * Returns the aggregated resource-readiness snapshot across every active
 * publisher under the nearest {@link ResourceStatusProvider}.
 *
 * Returns the empty/idle aggregate when no provider is mounted, so callers
 * can render unconditionally without crashing.
 *
 * @param filter Optional `{ kind }` to restrict the aggregate to a single
 *               resource kind.
 */
export function useResourceStatus(
  filter?: ResourceStatusFilter,
): AggregatedResourceStatus {
  const ctx = useResourceStatusContext();
  // `ctx.store.subscribe`/`getSnapshot` are arrow class fields, so they keep
  // a stable identity across renders without a useMemo wrapper.
  const subscribe = ctx?.store.subscribe ?? NOOP_SUBSCRIBE;
  const getSnapshot = ctx?.store.getSnapshot ?? GET_EMPTY_SNAPSHOT;

  const aggregate = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    if (!filter?.kind) return aggregate;
    const kind = filter.kind;

    // Walk the underlying entries scoped to this kind so we capture both
    // active publishers with a status *and* slots that registered with a
    // matching `kindHint` but haven't reported yet (analytics-warehouse
    // does this on mount so the indicator can show "0/N waiting" before
    // the first SSE event lands).
    const affectedLabels = new Set<string>();
    let activeCount = 0;
    let worst: ResourceStatus | null = null;
    if (ctx) {
      for (const entry of ctx.store.getEntries().values()) {
        const entryKind = entry.status?.kind ?? entry.kindHint;
        if (entryKind !== kind) continue;
        activeCount++;
        const status = entry.status;
        if (!status) continue;
        affectedLabels.add(entry.label);
        if (!worst || isWorse(status, worst)) {
          worst = status;
        }
      }
    }

    if (activeCount === 0)
      return { ...EMPTY_SNAPSHOT, version: aggregate.version };

    const byKind: Record<string, ResourceStatus> = {};
    if (worst) byKind[kind] = worst;

    return {
      worst,
      byKind,
      affectedLabels: [...affectedLabels].sort(),
      activeCount,
      elapsedMs: worst ? Math.max(0, Date.now() - worst.startedAt) : 0,
      version: aggregate.version,
    };
  }, [aggregate, ctx, filter?.kind]);
}

/**
 * Register a publisher with the nearest {@link ResourceStatusProvider}.
 * Plugins call this to push their resource readiness into the global
 * aggregate; the host app's {@link ResourceStatusIndicator} reads it.
 *
 * Safe to call when no provider is mounted — `publish`/`unpublish` are
 * no-ops in that case.
 *
 * @param id    Stable identifier for this publisher (e.g. a `useId()` value).
 * @param label Human-readable label surfaced via `affectedLabels` (e.g. a
 *              query key, an endpoint alias).
 *
 * @example
 * ```tsx
 * const id = useId();
 * const { publish, unpublish } = useResourceStatusPublisher(id, "my_chart");
 * useEffect(() => {
 *   publish({ kind: "warehouse", state: "STARTING", severity: "pending", startedAt: Date.now() });
 *   return () => unpublish();
 * }, [publish, unpublish]);
 * ```
 */
export function useResourceStatusPublisher(
  id: string,
  label: string,
  options?: { kindHint?: string },
): {
  publish: (status: ResourceStatus | null) => void;
  unpublish: () => void;
} {
  const ctx = useResourceStatusContext();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const kindHint = options?.kindHint;

  const publish = useCallback(
    (status: ResourceStatus | null) => {
      ctxRef.current?.store.publish(id, label, status, kindHint);
    },
    [id, label, kindHint],
  );
  const unpublish = useCallback(() => {
    ctxRef.current?.store.unpublish(id);
  }, [id]);

  return { publish, unpublish };
}
