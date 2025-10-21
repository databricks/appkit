import { randomUUID } from "node:crypto";
import type { IAppResponse } from "@databricks-apps/types";
import { BufferManager } from "./buffer-manager";
import { streamDefaults } from "./defaults";
import { SSEWriter } from "./sse-writer";
import type { StreamOperation, StreamOptions } from "./types";
import { StreamValidator } from "./validator";

export class StreamManager {
  protected activeOperations: Set<StreamOperation> = new Set();
  private bufferManager: BufferManager;
  private sseWriter: SSEWriter;
  private maxEventSize: number;

  constructor(options?: StreamOptions) {
    this.bufferManager = new BufferManager(options);
    this.sseWriter = new SSEWriter();
    this.maxEventSize = options?.maxEventSize ?? streamDefaults.maxEventSize;
  }

  async stream(
    res: IAppResponse,
    handler: (signal: AbortSignal) => AsyncGenerator<any, void, unknown>,
    options?: StreamOptions,
  ): Promise<void> {
    // setup SSE headers
    this.sseWriter.setupHeaders(res);

    // handle reconnection
    const didReconnect = this._handleReconnection(res, options);
    if (didReconnect) return;

    // setup signals and heartbeat
    const streamController = new AbortController();
    const combinedSignal = this._combineSignals(
      streamController.signal,
      options?.userSignal,
    );
    const heartbeat = this.sseWriter.startHeartbeat(res, combinedSignal);

    // track operation
    const streamOperation: StreamOperation = {
      controller: streamController,
      type: "stream",
      heartbeat,
    };
    this.activeOperations.add(streamOperation);

    // get buffer
    const eventBuffer = this.bufferManager.getOrCreateBuffer(options);

    let clientDisconnected = false;
    res.on("close", () => {
      clearInterval(heartbeat);
      clientDisconnected = true;
      this.activeOperations.delete(streamOperation);
    });

    try {
      const eventStream = handler(combinedSignal);

      // retrieve all events from generator
      for await (const event of eventStream) {
        if (combinedSignal.aborted) break;

        const eventId = randomUUID();
        const eventData = JSON.stringify(event);

        // validate event size

        if (eventData.length > this.maxEventSize) {
          if (!clientDisconnected && !res.writableEnded) {
            this.sseWriter.writeError(
              res,
              eventId,
              `Event data exceeds max size of ${this.maxEventSize} bytes`,
            );
          }
          continue;
        }

        // store event in buffer for reconnection
        eventBuffer.add({
          id: eventId,
          type: event.type,
          data: eventData,
          timestamp: Date.now(),
        });

        // send event if client still connected
        if (!clientDisconnected && !res.writableEnded) {
          this.sseWriter.writeEvent(res, eventId, event);
        }
      }

      if (
        !clientDisconnected &&
        !combinedSignal.aborted &&
        !res.writableEnded
      ) {
        res.end();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error";
      const errorEventId = randomUUID();

      // buffer error
      try {
        eventBuffer.add({
          id: errorEventId,
          type: "error",
          data: JSON.stringify({ error: errorMessage }),
          timestamp: Date.now(),
        });
      } catch (_bufferError) {
        // if buffering fails, try generic error event
        eventBuffer.add({
          id: errorEventId,
          type: "error",
          data: JSON.stringify({ error: "Internal server error" }),
          timestamp: Date.now(),
        });
      }
      if (!combinedSignal.aborted && !res.writableEnded) {
        try {
          this.sseWriter.writeError(res, errorEventId, errorMessage);
        } catch (_error) {}
        res.end();
      }
    } finally {
      clearInterval(heartbeat);
      this.activeOperations.delete(streamOperation);
    }
  }

  // abort all active operations
  abortAll(): void {
    this.activeOperations.forEach((operation) => {
      if (operation.heartbeat) clearInterval(operation.heartbeat);
      operation.controller.abort("Server shutdown");
    });
    this.activeOperations.clear();
    this.bufferManager.clear();
  }

  // get the number of active operations
  getActiveCount(): number {
    return this.activeOperations.size;
  }

  // handle reconnection from client
  private _handleReconnection(
    res: IAppResponse,
    options?: StreamOptions,
  ): boolean {
    const { streamId, userSignal } = options || {};
    if (!res.req?.headers) return false;

    const lastEventId = res.req.headers["last-event-id"] as string | undefined;
    if (!lastEventId) {
      return false;
    }

    if (!streamId) return false;

    // validate UUID
    if (!StreamValidator.isValidUUID(lastEventId)) return false;

    // validate streamId
    StreamValidator.validateStreamId(streamId);

    const bufferEntry = this.bufferManager.getBuffer(streamId);
    if (!bufferEntry) return false;

    // check if lastEventId is in buffer
    if (bufferEntry.buffer.has(lastEventId)) {
      bufferEntry.lastAccess = Date.now();
      // get missed events since lastEventId
      const missedEvents = bufferEntry.buffer.getEventsSince(lastEventId);

      if (missedEvents.length > 0) {
        for (const event of missedEvents) {
          if (userSignal?.aborted) break;
          this.sseWriter.writeRawEvent(res, event);
        }
        res.end();
        return true;
      }
    } else {
      // if lastEventId not found, overflow - notify client
      this.sseWriter.writeBufferOverflowWarning(res, lastEventId);
      this.bufferManager.deleteBuffer(streamId);
      return false;
    }
    return false;
  }

  private _combineSignals(
    internalSignal?: AbortSignal,
    userSignal?: AbortSignal,
  ): AbortSignal {
    if (!userSignal) return internalSignal || new AbortController().signal;

    const signals = [internalSignal];
    if (userSignal) signals.push(userSignal);

    const controller = new AbortController();

    signals.forEach((signal) => {
      if (signal?.aborted) {
        controller.abort(signal.reason);
        return;
      } else {
        signal?.addEventListener(
          "abort",
          () => {
            controller.abort(signal.reason);
          },
          { once: true },
        );
      }
    });

    return controller.signal;
  }
}
