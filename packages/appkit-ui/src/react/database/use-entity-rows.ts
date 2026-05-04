import { useCallback, useEffect, useState } from "react";
import {
  type DatabaseClient,
  type DatabaseEntityKey,
  type DatabaseRow,
  db,
  type EntityClient,
  type OrderInput,
  type WhereInput,
} from "@/js";

/** Proxy-backed entity chain with row shape widened so `select(string[])` typechecks before registry augmentation. */
type LooseEntityClient = EntityClient<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;

type RowOf<E extends DatabaseEntityKey> = DatabaseRow<E> extends never
  ? Record<string, unknown>
  : DatabaseRow<E>;

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

interface UseEntityRowsOptions<E extends DatabaseEntityKey> {
  where?: WhereInput<RowOf<E>>;
  order?: OrderInput<RowOf<E>>;
  limit?: number;
  select?: readonly string[];
  /**
   * When true, also fetches total row count via `db.<entity>.count(...)`.
   * Defaults to false so read-only tables avoid an extra request.
   */
  includeCount?: boolean;
}

interface UseEntityRowsResult<E extends DatabaseEntityKey> {
  rows: RowOf<E>[] | null;
  total: number | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Shared data-fetching hook for `<ViewEntity>` and similar list surfaces.
 *
 * - Every dependency change aborts the in-flight request to avoid racy
 *   `setState` after unmount.
 * - `refetch()` bumps an internal tick so callers can re-run manually
 *   (e.g. after a `<CreateEntity>` success) without remounting.
 * - Pass `includeCount: true` when you need `total`; otherwise only `toArray`
 *   runs (one fewer HTTP round-trip).
 */
export function useEntityRows<E extends DatabaseEntityKey>(
  entity: E,
  options: UseEntityRowsOptions<E> = {},
): UseEntityRowsResult<E> {
  const { where, order, limit = 50, select, includeCount = false } = options;

  const [rows, setRows] = useState<RowOf<E>[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  // Stable key derived from the filter inputs so useEffect reruns when they
  // change. JSON.stringify is fine here — where/order/select are small
  // JSON-shaped objects bound once per render by the parent.
  const whereKey = where ? JSON.stringify(where) : "";
  const orderKey = order ? JSON.stringify(order) : "";
  const selectKey = select ? select.join(",") : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: whereKey/orderKey/selectKey serialise where/order/select; tick is refetch
  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        let base = (db as DatabaseClient)[entity] as LooseEntityClient;
        if (where) base = base.where(where);
        let listQuery = base;
        if (order) listQuery = listQuery.order(order);
        if (select && select.length > 0) {
          listQuery = listQuery.select(...select);
        }
        listQuery = listQuery.limit(limit);

        if (includeCount) {
          const [data, count] = await Promise.all([
            listQuery.toArray(ctrl.signal),
            base.count(ctrl.signal),
          ]);
          if (!active) return;
          setRows(data as RowOf<E>[]);
          setTotal(count as number);
        } else {
          const data = await listQuery.toArray(ctrl.signal);
          if (!active) return;
          setRows(data as RowOf<E>[]);
          setTotal(null);
        }
      } catch (err) {
        if (!active || ctrl.signal.aborted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    run();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [entity, whereKey, orderKey, selectKey, limit, tick, includeCount]);

  return { rows, total, loading, error, refetch };
}
