import type { IAppResponse } from "@databricks-apps/types";

export interface StreamOptions {
  userSignal?: AbortSignal;
}

type StreamOperation = {
  controller: AbortController;
  type: "query" | "stream";
  heartbeat?: NodeJS.Timeout;
};

export class StreamManager {
  protected activeOperations: Set<StreamOperation> = new Set();

  /**
   * Stream handler for SSE responses with AsyncGenerator support
   * @param res - Response object
   * @param handler - Async generator that yields multiple events
   * @param options - Optional user-provided AbortSignal
   */
  async stream(
    res: IAppResponse,
    handler: (signal: AbortSignal) => AsyncGenerator<any, void, unknown>,
    options?: StreamOptions,
  ): Promise<void> {
    // 1. setup sse response headers
    this._setupStreamResponse(res);

    // 2. create internal abort controller
    const streamController = new AbortController();

    // 3. combine signals (internal + user-provided)
    const combinedSignal = options?.userSignal
      ? this._combineSignals([streamController.signal, options.userSignal])
      : streamController.signal;

    // 4. create heartbeat
    const heartbeat = this._createHeartbeat(res, combinedSignal);

    // 5. track active operation
    const streamOperation: StreamOperation = {
      controller: streamController,
      type: "stream",
      heartbeat,
    };
    this.activeOperations.add(streamOperation);

    // 6. handle client disconnect
    res.on("close", () => {
      clearInterval(heartbeat);
      streamController.abort("Client disconnected");
      this.activeOperations.delete(streamOperation);
    });

    try {
      // 7. get async generator from handler
      const eventStream = handler(combinedSignal);

      // 8. iterate over yielded events
      for await (const event of eventStream) {
        if (combinedSignal.aborted) break;

        // 9. write each event (sanitize type to prevent SSE injection)
        const eventType = (event?.type || "message")
          .replace(/[\r\n]/g, "")
          .slice(0, 100);
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      // 10. end stream after all events processed
      if (!combinedSignal.aborted && !res.writableEnded) {
        res.end();
      }
    } catch (error) {
      // 11. handle errors
      if (!combinedSignal.aborted && !res.writableEnded) {
        const errorMessage =
          error instanceof Error ? error.message : "Internal server error";
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        res.end();
      }
    } finally {
      // 12. cleanup
      clearInterval(heartbeat);
      this.activeOperations.delete(streamOperation);
    }
  }

  /**
   * Abort all active stream operations (for graceful shutdown)
   */
  abortAll(): void {
    this.activeOperations.forEach(({ controller, heartbeat }) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      controller.abort("Server shutdown");
    });
    this.activeOperations.clear();
  }

  /**
   * Get count of active operations
   */
  getActiveCount(): number {
    return this.activeOperations.size;
  }

  private _setupStreamResponse(res: IAppResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "none");
    res.flushHeaders?.();
  }

  private _createHeartbeat(
    res: IAppResponse,
    signal: AbortSignal,
  ): NodeJS.Timeout {
    return setInterval(() => {
      if (!signal.aborted) {
        res.write(": heartbeat\n\n");
      }
    }, 15000);
  }

  private _combineSignals(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    signals.forEach((signal) => {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener(
          "abort",
          () => controller.abort(signal.reason),
          {
            once: true,
          },
        );
      }
    });

    return controller.signal;
  }
}
