import type { sql } from "@databricks/sdk-experimental";
import type { Span } from "../../telemetry";
import type { WarehouseStatusUpdate } from "./client";

/**
 * Tracks state-change emissions for the warehouse readiness loop. Records
 * every poll on the OTel span and forwards real state changes (with de-dup)
 * to the route's `onStatus` callback. The raw SDK `health.summary` is
 * recorded on the span only — never on the wire.
 */
export class WarehouseStatusEmitter {
  attempt = 0;
  private lastEmittedState: sql.State | null = null;

  constructor(
    private readonly span: Span,
    private readonly startTime: number,
    private readonly onStatus: (update: WarehouseStatusUpdate) => void,
  ) {}

  emit(state: sql.State, summary: string | undefined): void {
    this.attempt += 1;
    this.span.addEvent("warehouse.status", {
      "db.warehouse.state": state,
      "db.warehouse.attempt": this.attempt,
      "db.warehouse.elapsed_ms": Date.now() - this.startTime,
      ...(summary ? { "db.warehouse.summary": summary } : {}),
    });
    if (state === this.lastEmittedState) return;
    this.lastEmittedState = state;
    try {
      this.onStatus({
        state,
        elapsedMs: Date.now() - this.startTime,
        attempt: this.attempt,
      });
    } catch (err) {
      this.span.addEvent("warehouse.onStatus.error", {
        "exception.message": err instanceof Error ? err.message : String(err),
      });
    }
  }
}
