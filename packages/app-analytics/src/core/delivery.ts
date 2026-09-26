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

/** Coordinates batching and delivery while keeping tracking calls synchronous. */
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
  private drainSingleRequested = false;
  private drainThroughSequence: number | undefined;
  private drainThroughUsesUnload = false;
  private drainUnloadRequested = false;
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
    } while (this.drainThroughSequence !== undefined);
  }

  private async runNextDrainRequest(): Promise<void> {
    if (this.queue.size === 0) {
      this.resetDrainRequests();
      return;
    }

    if (this.drainThroughSequence !== undefined) {
      const throughSequence = this.drainThroughSequence;
      const useUnload = this.drainThroughUsesUnload;
      this.drainThroughSequence = undefined;
      this.drainThroughUsesUnload = false;
      await this.drainThrough(throughSequence, useUnload);
      return;
    }

    if (this.drainUnloadRequested) {
      this.drainUnloadRequested = false;
      await this.deliverNextBatch("unload");
      // One bounded keepalive batch per lifecycle callback avoids exhausting
      // the browser's shared keepalive allowance.
      this.drainSingleRequested = false;
      this.postponeRemaining = true;
      return;
    }

    if (this.drainSingleRequested) {
      this.drainSingleRequested = false;
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
      const mode =
        useUnload || this.drainThroughUsesUnload || this.scheduler.isPageHidden
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
    if (prepared.kind !== "batch") {
      this.handleUnpreparedBatch(selected, prepared);
      return;
    }

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

  private handleUnpreparedBatch(
    selected: readonly QueuedEvent[],
    prepared: Exclude<ReturnType<typeof prepareBatch>, PreparedEventBatch>,
  ): void {
    if (prepared.kind === "empty") {
      this.emit({
        code: "delivery_failed",
        eventCount: selected.length,
        reason: "encoding",
      });
      return;
    }

    const rejectedIndex = selected.findIndex(
      ({ event }) => event === prepared.event,
    );
    const index = rejectedIndex === -1 ? 0 : rejectedIndex;
    this.requeue(selected.filter((_, itemIndex) => itemIndex !== index));
    this.emit({
      code:
        prepared.kind === "oversized" ? "event_too_large" : "delivery_failed",
      eventCount: 1,
      ...(prepared.kind === "encoding_error"
        ? { reason: "encoding" as const }
        : {}),
    });
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

        const canRetry =
          result.outcome === "retryable" && attempt < MAX_DELIVERY_ATTEMPTS;
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

        if (delayRetry) await waitForRetry();
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

    if (this.drainUnloadRequested) {
      void this.requestDrain("unload");
    } else if (
      !this.postponeRemaining &&
      (this.drainSingleRequested || this.queue.size >= MAX_EVENTS_PER_BATCH)
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
      this.drainThroughSequence = Math.max(
        this.drainThroughSequence ?? 0,
        throughSequence,
      );
      this.drainThroughUsesUnload ||= useUnload;
    }
    if (mode === "single") this.drainSingleRequested = true;
    if (mode === "unload") this.drainUnloadRequested = true;
  }

  private resetDrainRequests(): void {
    this.drainSingleRequested = false;
    this.drainThroughSequence = undefined;
    this.drainThroughUsesUnload = false;
    this.drainUnloadRequested = false;
  }

  private emit(diagnostic: AppAnalyticsDiagnostic): void {
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // Diagnostic callbacks are observational and must not affect delivery.
    }
  }
}

async function waitForRetry(): Promise<void> {
  const delay = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  if (delay === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
