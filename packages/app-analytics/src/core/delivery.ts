import type { BrowserEvent, AppAnalyticsDiagnostic } from "./event";
import { BoundedQueue } from "./queue";
import { DeliveryScheduler } from "./scheduler";
import {
  MAX_EVENTS_PER_BATCH,
  prepareBatch,
  sendBatch,
  sendBatchOnUnload,
  type DeliveryResult,
  type PreparedEventBatch,
} from "./transport";

const MAX_DELIVERY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_000;
/** A longer `Retry-After` gives up the retry instead of holding the queue. */
const MAX_RETRY_AFTER_MS = 10_000;

interface QueuedEvent {
  attempts: number;
  readonly endpoint: string;
  readonly event: BrowserEvent;
  readonly sequence: number;
}

interface ActiveDelivery {
  readonly batch: PreparedEventBatch;
  readonly endpoint: string;
  readonly items: readonly QueuedEvent[];
  replayAttempt?: number;
  replayPromise?: Promise<DeliveryResult>;
}

type DrainMode = "all" | "single" | "unload";
type DiagnosticListener = (diagnostic: AppAnalyticsDiagnostic) => void;

/**
 * Drain work requested while the queue is being delivered. Requests coalesce
 * and are served in this order:
 *
 * 1. `through` — `flush()`/`shutdown()`: deliver every event queued up to a
 *    sequence number, with keepalive when the page is hidden;
 * 2. `unload` — page hidden: one keepalive batch per lifecycle signal, so
 *    the browser's shared keepalive quota is not exhausted;
 * 3. `single` — the 5 s timer or a full batch: one normal batch.
 */
interface PendingDrains {
  single: boolean;
  unload: boolean;
  through: { sequence: number; useUnload: boolean } | undefined;
}

function noPendingDrains(): PendingDrains {
  return { single: false, unload: false, through: undefined };
}

/**
 * Coordinates batching and delivery while keeping tracking calls synchronous.
 *
 * One drain loop serves {@link PendingDrains}, so at most one request is in
 * flight. If the page is hidden while that request is pending, the same batch
 * is replayed with keepalive (`replayActiveDelivery`) because navigation can
 * cancel the original; the replay counts as the batch's retry.
 */
export class DeliveryPipeline {
  private readonly queue = new BoundedQueue<QueuedEvent>();
  private readonly scheduler = new DeliveryScheduler((reason) => {
    if (reason === "pagehide") {
      this.handlePageHide();
    } else {
      void this.requestDrain("single");
    }
  });

  private active = false;
  private activeDelivery: ActiveDelivery | undefined;
  private drainPromise: Promise<void> | undefined;
  private pending: PendingDrains = noPendingDrains();
  private nextSequence = 1;
  private postponeRemaining = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly onDiagnostic: DiagnosticListener) {}

  start(): void {
    if (this.active || this.shutdownPromise !== undefined) return;
    this.active = true;
    this.scheduler.start();
  }

  enqueue(endpoint: string, event: BrowserEvent): boolean {
    if (!this.active) return false;

    if (
      !this.queue.enqueue({
        attempts: 0,
        endpoint,
        event,
        sequence: this.nextSequence,
      })
    ) {
      this.emit({ code: "queue_overflow", eventCount: 1 });
      return false;
    }
    this.nextSequence += 1;

    if (this.scheduler.isPageHidden) {
      this.scheduler.cancel();
      void this.requestDrain("unload");
    } else if (this.queue.size >= MAX_EVENTS_PER_BATCH) {
      this.scheduler.cancel();
      void this.requestDrain("single");
    } else {
      this.scheduler.schedule();
    }
    return true;
  }

  flush(): Promise<void> {
    const useUnload = this.scheduler.isPageHidden;
    this.scheduler.cancel();
    return this.requestDrain("all", this.nextSequence - 1, useUnload);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;

    this.active = false;
    const useUnload = this.scheduler.isPageHidden;
    this.scheduler.stop();
    const operation = this.requestDrain(
      "all",
      this.nextSequence - 1,
      useUnload,
    ).finally(() => {
      const droppedCount = this.queue.clear();
      if (droppedCount > 0) {
        this.emit({ code: "delivery_failed", eventCount: droppedCount });
      }
      this.resetDrainRequests();
      this.nextSequence = 1;
      this.shutdownPromise = undefined;
    });
    this.shutdownPromise = operation;
    return operation;
  }

  private handlePageHide(): void {
    this.replayActiveDelivery();
    void this.requestDrain("unload");
  }

  private replayActiveDelivery(): void {
    const delivery = this.activeDelivery;
    const currentAttempt = delivery?.items[0]?.attempts;
    if (
      delivery === undefined ||
      delivery.replayPromise !== undefined ||
      currentAttempt === undefined ||
      currentAttempt >= MAX_DELIVERY_ATTEMPTS
    ) {
      return;
    }

    const replayAttempt = currentAttempt + 1;
    for (const item of delivery.items) item.attempts = replayAttempt;
    delivery.replayAttempt = replayAttempt;
    // Calling the async transport starts fetch synchronously, before the
    // pagehide callback returns. The result is reconciled by the active drain.
    delivery.replayPromise = sendBatchOnUnload(
      delivery.endpoint,
      delivery.batch,
    );
  }

  private requestDrain(
    mode: DrainMode,
    throughSequence?: number,
    useUnload = false,
  ): Promise<void> {
    this.setDrainRequest(mode, throughSequence, useUnload);

    if (this.drainPromise !== undefined) return this.drainPromise;
    if (this.queue.size === 0) {
      this.resetDrainRequests();
      return Promise.resolve();
    }

    // Start immediately so pagehide can hand the request to the browser before
    // the lifecycle callback returns. The async loop still yields at transport.
    const operation = this.executeDrainRequests()
      .catch(() => {
        const droppedCount = this.queue.clear();
        if (droppedCount > 0) {
          this.emit({ code: "delivery_failed", eventCount: droppedCount });
        }
        this.resetDrainRequests();
      })
      .finally(() => {
        this.drainPromise = undefined;
        this.scheduleRemaining();
      });
    this.drainPromise = operation;
    return operation;
  }

  private async executeDrainRequests(): Promise<void> {
    do {
      await this.runNextDrainRequest();
    } while (this.pending.through !== undefined);
  }

  private async runNextDrainRequest(): Promise<void> {
    if (this.queue.size === 0) {
      this.resetDrainRequests();
      return;
    }

    const through = this.pending.through;
    if (through !== undefined) {
      this.pending.through = undefined;
      await this.drainThrough(through.sequence, through.useUnload);
      return;
    }

    if (this.pending.unload) {
      this.pending.unload = false;
      await this.deliverNextBatch("unload");
      // One bounded keepalive batch per lifecycle callback avoids exhausting
      // the browser's shared keepalive allowance.
      this.pending.single = false;
      this.postponeRemaining = true;
      return;
    }

    if (this.pending.single) {
      this.pending.single = false;
      await this.deliverNextBatch("single");
    }
  }

  private async drainThrough(
    throughSequence: number,
    useUnload: boolean,
  ): Promise<void> {
    for (;;) {
      const next = this.queue.peek();
      if (next === undefined || next.sequence > throughSequence) return;
      // A flush requested while this one runs may have asked for keepalive.
      const mode =
        useUnload ||
        this.pending.through?.useUnload === true ||
        this.scheduler.isPageHidden
          ? "unload"
          : "all";
      await this.deliverNextBatch(mode, throughSequence);
    }
  }

  private async deliverNextBatch(
    mode: DrainMode,
    throughSequence?: number,
  ): Promise<void> {
    const selected = this.takeEndpointBatch(throughSequence);
    if (selected.length === 0) return;

    const prepared = prepareBatch(selected.map(({ event }) => event));
    if (prepared.kind === "oversized" || prepared.kind === "encoding_error") {
      this.dropHeadEvent(selected, prepared.kind);
      return;
    }
    if (prepared.kind !== "batch") return;

    const batchItems = selected.slice(0, prepared.events.length);
    this.requeue(selected.slice(prepared.events.length));

    if (mode === "unload") {
      const firstItem = batchItems[0];
      if (firstItem === undefined) return;
      const attempt = firstItem.attempts + 1;
      for (const item of batchItems) item.attempts = attempt;
      const result = await sendBatchOnUnload(firstItem.endpoint, prepared);
      this.handleUnloadResult(batchItems, result);
      return;
    }

    await this.deliverWithRetry(batchItems, prepared, mode === "single");
  }

  private takeEndpointBatch(throughSequence?: number): QueuedEvent[] {
    const selected = this.queue.take(MAX_EVENTS_PER_BATCH);
    const first = selected[0];
    if (first === undefined) return [];

    const boundary = selected.findIndex(
      ({ attempts, endpoint, sequence }) =>
        endpoint !== first.endpoint ||
        attempts !== first.attempts ||
        (throughSequence !== undefined && sequence > throughSequence),
    );
    if (boundary === -1) return selected;

    this.requeue(selected.slice(boundary));
    return selected.slice(0, boundary);
  }

  /** `prepareBatch` rejects only the head event; the rest go back in order. */
  private dropHeadEvent(
    selected: readonly QueuedEvent[],
    kind: "encoding_error" | "oversized",
  ): void {
    this.requeue(selected.slice(1));
    this.emit(
      kind === "oversized"
        ? { code: "event_too_large", eventCount: 1 }
        : { code: "delivery_failed", eventCount: 1, reason: "encoding" },
    );
  }

  private async deliverWithRetry(
    items: readonly QueuedEvent[],
    batch: PreparedEventBatch,
    delayRetry: boolean,
  ): Promise<void> {
    const firstItem = items[0];
    if (firstItem === undefined) return;

    const delivery: ActiveDelivery = {
      batch,
      endpoint: firstItem.endpoint,
      items,
    };
    this.activeDelivery = delivery;

    try {
      for (
        let attempt = firstItem.attempts + 1;
        attempt <= MAX_DELIVERY_ATTEMPTS;
        attempt += 1
      ) {
        if (delivery.replayPromise !== undefined) {
          await this.finishLifecycleReplay(delivery);
          return;
        }

        for (const item of items) item.attempts = attempt;
        const result = await sendBatch(firstItem.endpoint, batch, {
          // The initial request avoids consuming the browser-wide keepalive
          // quota. A retry is keepalive-safe if navigation begins mid-request.
          keepalive: attempt > 1,
        });
        if (result.outcome === "accepted") {
          // A pagehide replay may already be in flight for this batch. Keep it
          // attached to the drain so lifecycle methods do not resolve while a
          // request owned by this pipeline is still using keepalive capacity.
          if (delivery.replayPromise !== undefined) {
            await delivery.replayPromise;
          }
          return;
        }

        const retryAfterMs =
          result.outcome === "retryable" ? result.retryAfterMs : undefined;
        const canRetry =
          result.outcome === "retryable" &&
          attempt < MAX_DELIVERY_ATTEMPTS &&
          (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS);
        if (canRetry) {
          this.emit({
            code: "delivery_retry",
            eventCount: batch.events.length,
            attempt,
            reason: result.reason,
            ...(result.status === undefined ? {} : { status: result.status }),
          });
        }

        if (delivery.replayPromise !== undefined) {
          await this.finishLifecycleReplay(delivery);
          return;
        }

        if (!canRetry) {
          this.emitDeliveryFailure(batch.events.length, attempt, result);
          return;
        }

        if (delayRetry) await waitForRetry(retryAfterMs);
      }
    } finally {
      if (this.activeDelivery === delivery) this.activeDelivery = undefined;
    }
  }

  private async finishLifecycleReplay(delivery: ActiveDelivery): Promise<void> {
    const replay = delivery.replayPromise;
    if (replay === undefined) return;

    const result = await replay;
    if (result.outcome === "accepted") return;

    this.emitDeliveryFailure(
      delivery.items.length,
      delivery.replayAttempt ?? MAX_DELIVERY_ATTEMPTS,
      result,
    );
  }

  private handleUnloadResult(
    items: readonly QueuedEvent[],
    result: DeliveryResult,
  ): void {
    if (result.outcome === "accepted") return;

    if (result.outcome === "retryable") {
      const attempt = items[0]?.attempts ?? MAX_DELIVERY_ATTEMPTS;
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        this.requeue(items);
        this.emit({
          code: "delivery_retry",
          eventCount: items.length,
          attempt,
          reason: result.reason,
          ...(result.status === undefined ? {} : { status: result.status }),
        });
      } else {
        this.emitDeliveryFailure(items.length, attempt, result);
      }
      return;
    }

    this.emitDeliveryFailure(
      items.length,
      items[0]?.attempts ?? MAX_DELIVERY_ATTEMPTS,
      result,
    );
  }

  private emitDeliveryFailure(
    eventCount: number,
    attempt: number,
    result: Exclude<DeliveryResult, { outcome: "accepted" }>,
  ): void {
    this.emit({
      code: "delivery_failed",
      eventCount,
      attempt,
      reason: result.reason,
      ...(result.status === undefined ? {} : { status: result.status }),
    });
  }

  private requeue(items: readonly QueuedEvent[]): void {
    if (items.length === 0) return;

    const droppedCount = this.queue.requeueFront(items);
    if (droppedCount > 0) {
      this.emit({ code: "queue_overflow", eventCount: droppedCount });
    }
  }

  private scheduleRemaining(): void {
    if (this.queue.size === 0) {
      this.resetDrainRequests();
      this.postponeRemaining = false;
      return;
    }
    if (!this.active) {
      this.postponeRemaining = false;
      return;
    }

    if (this.pending.unload) {
      void this.requestDrain("unload");
    } else if (
      !this.postponeRemaining &&
      (this.pending.single || this.queue.size >= MAX_EVENTS_PER_BATCH)
    ) {
      void this.requestDrain("single");
    } else {
      this.scheduler.schedule();
    }
    this.postponeRemaining = false;
  }

  private setDrainRequest(
    mode: DrainMode,
    throughSequence?: number,
    useUnload = false,
  ): void {
    if (mode === "all" && throughSequence !== undefined) {
      const current = this.pending.through;
      this.pending.through = {
        sequence: Math.max(current?.sequence ?? 0, throughSequence),
        useUnload: (current?.useUnload ?? false) || useUnload,
      };
    }
    if (mode === "single") this.pending.single = true;
    if (mode === "unload") this.pending.unload = true;
  }

  private resetDrainRequests(): void {
    this.pending = noPendingDrains();
  }

  private emit(diagnostic: AppAnalyticsDiagnostic): void {
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostic callbacks are observational and must not affect delivery.
    }
  }
}

/** Full jitter, or the server's `Retry-After` when it asks for longer. */
async function waitForRetry(retryAfterMs = 0): Promise<void> {
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  const delay = Math.max(jitter, retryAfterMs);
  if (delay === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
