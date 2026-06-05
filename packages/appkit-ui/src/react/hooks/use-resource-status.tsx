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
 * Cross-kind severity, ordered worst-first (`error > warning > pending`).
 * Callers `unpublish` rather than publishing a status for ready resources.
 */
export type ResourceSeverity = "pending" | "warning" | "error";

/**
 * Readiness snapshot for a single resource (SQL warehouse, Lakebase
 * connection, model-serving endpoint, …). Plugins publish these while a
 * user-visible cold start / warm-up / unavailability is in flight.
 */
export interface ResourceStatus {
  /** Resource family, conventionally lowercase-kebab (`"warehouse"`, `"lakebase"`). */
  kind: string;
  /** Resource-specific raw state, e.g. `"STARTING"`, `"DELETED"`. Opaque to the aggregator. */
  state: string;
  severity: ResourceSeverity;
  /** Human-readable summary forwarded to the indicator UI. */
  summary?: string;
  /** Epoch ms when the publisher started waiting; drives `elapsedMs`. */
  startedAt: number;
}

/** Aggregate view of every active publisher; returned by {@link useResourceStatus}. */
export interface AggregatedResourceStatus {
  /** Highest-severity status across all publishers, or `null` when nothing is pending. */
  worst: ResourceStatus | null;
  /** Worst status per `kind`. */
  byKind: Record<string, ResourceStatus>;
  /** De-duped, sorted labels of every publisher with a non-null status. */
  affectedLabels: string[];
  /** Total registered publishers (including those whose status is `null`). */
  activeCount: number;
  /** Milliseconds since the worst entry's `startedAt`; `0` when nothing is pending. */
  elapsedMs: number;
  /** Monotonic counter bumped on every `publish`/`unpublish`. */
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
 * Internal registry record. `kindHint` keeps status-less slots associated
 * with their kind so kind-scoped views can count "registered but not yet
 * reporting" publishers (e.g. analytics charts before the first SSE event).
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

/** Flat per-publisher map exposed to React via `useSyncExternalStore`. */
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
    this.bump();
  }

  unpublish(id: string): void {
    if (this.entries.delete(id)) this.bump();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AggregatedResourceStatus {
    return this.snapshot;
  }

  /** Exposed for the kind-filter path so it can pick up status-less `kindHint` slots. */
  getEntries(): Map<string, RegistryEntry> {
    return this.entries;
  }

  private bump(): void {
    this.version += 1;
    this.snapshot = aggregate(this.entries, this.version);
    for (const l of this.listeners) l();
  }
}

function isWorse(a: ResourceStatus, b: ResourceStatus): boolean {
  const aRank = SEVERITY_RANK[a.severity];
  const bRank = SEVERITY_RANK[b.severity];
  if (aRank !== bRank) return aRank < bRank;
  // Same severity → longer-pending entry wins.
  return a.startedAt < b.startedAt;
}

/** Pure derivation of the snapshot from `entries` at a given `version`. */
function aggregate(
  entries: Map<string, RegistryEntry>,
  version: number,
): AggregatedResourceStatus {
  if (entries.size === 0) return { ...EMPTY_SNAPSHOT, version };

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
    version,
  };
}

/** Kind-scoped aggregate; walks entries directly to include status-less `kindHint` slots. */
function aggregateForKind(
  entries: Map<string, RegistryEntry>,
  kind: string,
  version: number,
): AggregatedResourceStatus {
  const affectedLabels = new Set<string>();
  let activeCount = 0;
  let worst: ResourceStatus | null = null;

  for (const entry of entries.values()) {
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

  if (activeCount === 0) return { ...EMPTY_SNAPSHOT, version };

  const byKind: Record<string, ResourceStatus> = {};
  if (worst) byKind[kind] = worst;

  return {
    worst,
    byKind,
    affectedLabels: [...affectedLabels].sort(),
    activeCount,
    elapsedMs: worst ? Math.max(0, Date.now() - worst.startedAt) : 0,
    version,
  };
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
 * readiness aggregate. Plugins publish {@link ResourceStatus} snapshots
 * while a resource is warming up / unavailable; {@link useResourceStatus}
 * exposes the worst across all of them.
 *
 * Without a provider, `useResourceStatus` and `useResourceStatusPublisher`
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
 * publisher under the nearest {@link ResourceStatusProvider}. Falls back
 * to the empty/idle aggregate when no provider is mounted.
 *
 * @param filter Optional `{ kind }` to scope to a single resource kind.
 */
export function useResourceStatus(
  filter?: ResourceStatusFilter,
): AggregatedResourceStatus {
  const ctx = useResourceStatusContext();
  const store = ctx?.store;

  const subscribe = useMemo(
    () =>
      store
        ? (listener: () => void) => store.subscribe(listener)
        : NOOP_SUBSCRIBE,
    [store],
  );
  const getSnapshot = useMemo(
    () => (store ? () => store.getSnapshot() : GET_EMPTY_SNAPSHOT),
    [store],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => {
    if (!filter?.kind) return snapshot;
    if (!store) return { ...EMPTY_SNAPSHOT, version: snapshot.version };
    return aggregateForKind(store.getEntries(), filter.kind, snapshot.version);
  }, [snapshot, store, filter?.kind]);
}

/**
 * Register a publisher with the nearest {@link ResourceStatusProvider}.
 * Safe to call without a provider — `publish`/`unpublish` are no-ops.
 *
 * @param id    Stable identifier (e.g. a `useId()` value).
 * @param label Human-readable label surfaced via `affectedLabels`.
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
