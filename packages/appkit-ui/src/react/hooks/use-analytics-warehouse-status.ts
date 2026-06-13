import { useCallback, useRef } from "react";
import type { WarehouseStatus } from "./types";
import {
  type ResourceSeverity,
  useResourceStatusPublisher,
} from "./use-resource-status";

const ANALYTICS_WAREHOUSE_RESOURCE_KIND = "warehouse";

/**
 * - `RUNNING` → `null`; callers `unpublish` instead.
 * - `STARTING` / `STOPPED` / `STOPPING` → `pending`.
 * - `DELETED` / `DELETING` → `error` (config change required).
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
 * Internal hook used by `useAnalyticsQuery` to mirror its current warehouse
 * status into the nearest provider. No-op when no provider is mounted.
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

  // Anchor `startedAt` to the first non-null status so `elapsedMs`
  // advances monotonically across successive `warehouse_status` events.
  const startedAtRef = useRef<number | null>(null);

  const publish = useCallback(
    (status: WarehouseStatus | null) => {
      // null covers "register with no status yet" *and* RUNNING — both
      // keep the slot registered without contributing to the aggregate.
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
