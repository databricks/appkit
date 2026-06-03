import { useCallback, useRef } from "react";
import type { WarehouseStatus } from "./types";
import {
  type ResourceSeverity,
  useResourceStatusPublisher,
} from "./use-resource-status";

/**
 * Resource-status `kind` used by the analytics warehouse adapter. Plugins
 * outside of analytics should publish under a different kind so the
 * indicator can show kind-specific copy.
 */
const ANALYTICS_WAREHOUSE_RESOURCE_KIND = "warehouse";

/**
 * Map a {@link WarehouseStatus} to the cross-kind severity used by the
 * generic resource-status store.
 *
 * - `RUNNING` → no severity; callers should `unpublish` instead of
 *   publishing a status.
 * - `STARTING` / `STOPPED` / `STOPPING` → `pending` (user is waiting on a
 *   cold start / restart).
 * - `DELETED` / `DELETING` → `error` (the configured warehouse is unusable
 *   and a config change is required).
 */
function severityForWarehouseState(
  state: WarehouseStatus["state"],
): ResourceSeverity | null {
  switch (state) {
    case "RUNNING":
      return null;
    case "DELETED":
    case "DELETING":
      return "error";
    default:
      return "pending";
  }
}

/**
 * Internal hook used by `useAnalyticsQuery` to register/unregister and update
 * its current warehouse status with the nearest provider. Safe to call when
 * no provider is mounted — in that case the publish/unpublish calls are
 * no-ops.
 *
 * @returns A stable `publish(status)` callback. Pair with a cleanup effect
 *          that calls `unpublish()` on unmount.
 */
export function useAnalyticsWarehousePublisher(
  id: string,
  queryKey: string,
): {
  publish: (status: WarehouseStatus | null) => void;
  unpublish: () => void;
} {
  const { publish: publishGeneric, unpublish } = useResourceStatusPublisher(
    id,
    queryKey,
    { kindHint: ANALYTICS_WAREHOUSE_RESOURCE_KIND },
  );

  // Anchor `startedAt` to the *first* non-null status of a wait so the
  // aggregate's `elapsedMs` counter advances monotonically. Without this,
  // every successive `warehouse_status` event would recompute startedAt
  // from a fresh `Date.now()`, causing the indicator's elapsed counter to
  // jitter or briefly go backwards between events.
  const startedAtRef = useRef<number | null>(null);

  const publish = useCallback(
    (status: WarehouseStatus | null) => {
      // `null` payload covers both: (a) "register me, no status yet" and
      // (b) RUNNING — both keep the slot registered without making this
      // entry contribute to the aggregate's worst-status calculation.
      const severity = status && severityForWarehouseState(status.state);
      if (!status || !severity) {
        startedAtRef.current = null;
        publishGeneric(null);
        return;
      }
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now() - Math.max(0, status.elapsedMs);
      }
      publishGeneric({
        kind: ANALYTICS_WAREHOUSE_RESOURCE_KIND,
        state: status.state,
        severity,
        startedAt: startedAtRef.current,
      });
    },
    [publishGeneric],
  );

  return { publish, unpublish };
}
