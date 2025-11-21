import { randomUUID } from "node:crypto";
import type { IAppResponse, StreamConfig } from "@databricks-apps/types";
import { EventRingBuffer } from "./buffers";
import { streamDefaults } from "./defaults";
import { SSEWriter } from "./sse-writer";
import { StreamRegistry } from "./stream-registry";
import { SSEErrorCode, type StreamEntry, type StreamOperation } from "./types";
import { StreamValidator } from "./validator";

// main entry point for Server-Sent events streaming
export class StreamManager {
  private activeOperations: Set<StreamOperation>;
  private streamRegistry: StreamRegistry;
  private sseWriter: SSEWriter;
  private maxEventSize: number;
  private bufferTTL: number;

  constructor(options?: StreamConfig) {
    this.streamRegistry = new StreamRegistry(
      options?.maxActiveStreams ?? streamDefaults.maxActiveStreams,
    );
    this.sseWriter = new SSEWriter();
    this.maxEventSize = options?.maxEventSize ?? streamDefaults.maxEventSize;
    this.bufferTTL = options?.bufferTTL ?? streamDefaults.bufferTTL;
    this.activeOperations = new Set();
  }

  // main streaming method - handles new connection and reconnection
  stream(
    res: IAppResponse,
    handler: (signal: AbortSignal) => AsyncGenerator<any, void, unknown>,
    options?: StreamConfig,
  ): Promise<void> {
    const { streamId } = options || {};

    // setup SSE headers
    this.sseWriter.setupHeaders(res);

    // handle reconnection
    if (streamId && StreamValidator.validateStreamId(streamId)) {
      const existingStream = this.streamRegistry.get(streamId);
      // if stream exists, attach to it
      if (existingStream) {
        return this._attachToExistingStream(res, existingStream, options);
      }
    }

    // if stream does not exist, create a new one
    return this._createNewStream(res, handler, options);
  }

  // abort all active operations
  abortAll(): void {
    this.activeOperations.forEach((operation) => {
      if (operation.heartbeat) clearInterval(operation.heartbeat);
      operation.controller.abort("Server shutdown");
    });
    this.activeOperations.clear();
    this.streamRegistry.clear();
  }

  // get the number of active operations
  getActiveCount(): number {
    return this.activeOperations.size;
  }

  // attach to existing stream
  private async _attachToExistingStream(
    res: IAppResponse,
    streamEntry: StreamEntry,
    options?: StreamConfig,
  ): Promise<void> {
    // handle reconnection - replay missed events
    const lastEventId = res.req?.headers["last-event-id"];

    if (StreamValidator.validateEventId(lastEventId)) {
      // cast to string after validation
      const validEventId = lastEventId as string;
      if (streamEntry.eventBuffer.has(validEventId)) {
        const missedEvents =
          streamEntry.eventBuffer.getEventsSince(validEventId);
        // broadcast missed events to client
        for (const event of missedEvents) {
          if (options?.userSignal?.aborted) break;
          this.sseWriter.writeBufferedEvent(res, event);
        }
      } else {
        // buffer overflow - send warning
        this.sseWriter.writeBufferOverflowWarning(res, validEventId);
      }
    }

    // add client to stream entry
    streamEntry.clients.add(res);
    streamEntry.lastAccess = Date.now();

    // start heartbeat
    const combinedSignal = this._combineSignals(
      streamEntry.abortController.signal,
      options?.userSignal,
    );
    const heartbeat = this.sseWriter.startHeartbeat(res, combinedSignal);

    // track operation
    const streamOperation: StreamOperation = {
      controller: streamEntry.abortController,
      type: "stream",
      heartbeat,
    };
    this.activeOperations.add(streamOperation);

    // handle client disconnect
    res.on("close", () => {
      clearInterval(heartbeat);
      streamEntry.clients.delete(res);
      this.activeOperations.delete(streamOperation);

      // cleanup if stream is completed and no clients are connected
      if (streamEntry.isCompleted && streamEntry.clients.size === 0) {
        setTimeout(() => {
          if (streamEntry.clients.size === 0) {
            this.streamRegistry.remove(streamEntry.streamId);
          }
        }, this.bufferTTL);
      }
    });

    // if stream is completed, close connection
    if (streamEntry.isCompleted) {
      res.end();
      // cleanup operation
      this.activeOperations.delete(streamOperation);
      clearInterval(heartbeat);
    }
  }
  private async _createNewStream(
    res: IAppResponse,
    handler: (signal: AbortSignal) => AsyncGenerator<any, void, unknown>,
    options?: StreamConfig,
  ): Promise<void> {
    const streamId = options?.streamId ?? randomUUID();
    const abortController = new AbortController();

    // create event buffer
    const eventBuffer = new EventRingBuffer(
      options?.bufferSize ?? streamDefaults.bufferSize,
    );

    // setup signals and heartbeat
    const combinedSignal = this._combineSignals(
      abortController.signal,
      options?.userSignal,
    );
    const heartbeat = this.sseWriter.startHeartbeat(res, combinedSignal);

    // create stream entry
    const streamEntry: StreamEntry = {
      streamId,
      generator: handler(combinedSignal),
      eventBuffer,
      clients: new Set([res]),
      isCompleted: false,
      lastAccess: Date.now(),
      abortController,
    };
    this.streamRegistry.add(streamEntry);

    // track operation
    const streamOperation: StreamOperation = {
      controller: abortController,
      type: "stream",
      heartbeat,
    };
    this.activeOperations.add(streamOperation);

    // handle client disconnect
    res.on("close", () => {
      clearInterval(heartbeat);
      this.activeOperations.delete(streamOperation);
      streamEntry.clients.delete(res);
    });

    await this._processGeneratorInBackground(streamEntry);

    // cleanup
    clearInterval(heartbeat);
    this.activeOperations.delete(streamOperation);
  }

  private async _processGeneratorInBackground(
    streamEntry: StreamEntry,
  ): Promise<void> {
    try {
      // retrieve all events from generator
      for await (const event of streamEntry.generator) {
        if (streamEntry.abortController.signal.aborted) break;
        const eventId = randomUUID();
        const eventData = JSON.stringify(event);

        // validate event size
        if (eventData.length > this.maxEventSize) {
          const errorMsg = `Event exceeds max size of ${this.maxEventSize} bytes`;
          const errorCode = SSEErrorCode.INVALID_REQUEST;
          // broadcast error to all connected clients
          this._broadcastErrorToClients(
            streamEntry,
            eventId,
            errorMsg,
            errorCode,
          );
          continue;
        }

        // buffer event for reconnection
        streamEntry.eventBuffer.add({
          id: eventId,
          type: event.type,
          data: eventData,
          timestamp: Date.now(),
        });

        // broadcast to all connected clients
        this._broadcastEventsToClients(streamEntry, eventId, event);
        streamEntry.lastAccess = Date.now();
      }

      streamEntry.isCompleted = true;

      // close all clients
      this._closeAllClients(streamEntry);

      // cleanup if no clients are connected
      this._cleanupStream(streamEntry);
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Internal server error";
      const errorEventId = randomUUID();
      const errorCode = this._categorizeError(error);

      // buffer error event
      streamEntry.eventBuffer.add({
        id: errorEventId,
        type: "error",
        data: JSON.stringify({ error: errorMsg, code: errorCode }),
        timestamp: Date.now(),
      });

      // send error event to all connected clients
      this._broadcastErrorToClients(
        streamEntry,
        errorEventId,
        errorMsg,
        errorCode,
        true,
      );
      streamEntry.isCompleted = true;
    }
  }

  private _combineSignals(
    internalSignal?: AbortSignal,
    userSignal?: AbortSignal,
  ): AbortSignal {
    if (!userSignal) return internalSignal || new AbortController().signal;

    const signals = [internalSignal, userSignal].filter(
      Boolean,
    ) as AbortSignal[];
    const controller = new AbortController();

    signals.forEach((signal) => {
      if (signal?.aborted) {
        controller.abort(signal.reason);
        return;
      }

      signal?.addEventListener(
        "abort",
        () => {
          controller.abort(signal.reason);
        },
        { once: true },
      );
    });
    return controller.signal;
  }

  // broadcast events to all connected clients
  private _broadcastEventsToClients(
    streamEntry: StreamEntry,
    eventId: string,
    event: any,
  ): void {
    for (const client of streamEntry.clients) {
      if (!client.writableEnded) {
        this.sseWriter.writeEvent(client, eventId, event);
      }
    }
  }

  // broadcast error to all connected clients
  private _broadcastErrorToClients(
    streamEntry: StreamEntry,
    eventId: string,
    errorMessage: string,
    errorCode: SSEErrorCode,
    closeClients: boolean = false,
  ): void {
    for (const client of streamEntry.clients) {
      if (!client.writableEnded) {
        this.sseWriter.writeError(client, eventId, errorMessage, errorCode);
        if (closeClients) {
          client.end();
        }
      }
    }
  }

  // close all connected clients
  private _closeAllClients(streamEntry: StreamEntry): void {
    for (const client of streamEntry.clients) {
      if (!client.writableEnded) {
        client.end();
      }
    }
  }

  // cleanup stream if no clients are connected
  private _cleanupStream(streamEntry: StreamEntry): void {
    if (streamEntry.clients.size === 0) {
      setTimeout(() => {
        if (streamEntry.clients.size === 0) {
          this.streamRegistry.remove(streamEntry.streamId);
        }
      }, this.bufferTTL);
    }
  }

  private _categorizeError(error: unknown): SSEErrorCode {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timeout") || message.includes("timed out")) {
        return SSEErrorCode.TIMEOUT;
      }

      if (message.includes("unavailable") || message.includes("econnrefused")) {
        return SSEErrorCode.TEMPORARY_UNAVAILABLE;
      }

      if (error.name === "AbortError") {
        return SSEErrorCode.STREAM_ABORTED;
      }
    }

    return SSEErrorCode.INTERNAL_ERROR;
  }
}
