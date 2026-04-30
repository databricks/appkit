import type { IAppResponse } from "shared";
import { streamDefaults } from "./defaults";
import {
  type BufferedEvent,
  type SSEError,
  SSEErrorCode,
  SSEWarningCode,
} from "./types";
import { StreamValidator } from "./validator";

export class SSEWriter {
  // setup SSE headers
  setupHeaders(res: IAppResponse): void {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    // X-Accel-Buffering: no — disables nginx-style proxy response buffering
    // for SSE (used by Cloudflare, AWS, GCP, and most corporate proxies).
    res.setHeader("X-Accel-Buffering", "no");
    // Intentionally NOT setting:
    //   - Connection: keep-alive   (HTTP/2 forbids it; Node manages keep-alive)
    //   - Content-Encoding: none   (invalid value; can trigger 502/RST in
    //                                strict intermediaries)
    res.flushHeaders?.();
    // Sentinel comment — a no-op SSE line that forces the response body
    // open immediately. Two purposes:
    //   1. Any buffering proxy must release the response headers + this
    //      first chunk to the client right away, so fetch() resolves with
    //      response.ok before the upstream generator yields.
    //   2. Prevents "Failed to fetch" symptoms where the browser gives up
    //      before the SQL query completes on cold-start warehouses.
    if (!res.writableEnded) {
      try {
        res.write(": ok\n\n");
      } catch {
        // ignore — handled by writeEvent's writableEnded check downstream
      }
    }
  }

  // write a single event to the response
  writeEvent(res: IAppResponse, eventId: string, event: any): void {
    if (res.writableEnded) return;

    const eventType = StreamValidator.sanitizeEventType(event.type);
    const eventData = JSON.stringify(event);

    res.write(`id: ${eventId}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${eventData}\n\n`);
  }
  writeError(
    res: IAppResponse,
    eventId: string,
    error: string,
    code: SSEErrorCode = SSEErrorCode.INTERNAL_ERROR,
  ): void {
    if (res.writableEnded) return;

    const errorData: SSEError = {
      error,
      code,
    };

    res.write(`id: ${eventId}\n`);
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify(errorData)}\n\n`);
  }

  // write a buffered event for replay
  writeBufferedEvent(res: IAppResponse, event: BufferedEvent): void {
    if (res.writableEnded) return;

    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${event.data}\n\n`);
  }

  // write a buffer overflow warning
  writeBufferOverflowWarning(res: IAppResponse, lastEventId: string): void {
    if (res.writableEnded) return;

    try {
      res.write(`event: warning\n`);
      res.write(
        `data: ${JSON.stringify({
          warning: "Buffer overflow detected - some events were lost",
          code: SSEWarningCode.BUFFER_OVERFLOW_RESTART,
          lastEventId,
        })}\n\n`,
      );
    } catch (_error) {
      // ignore write errors - client will ignore this event
    }
  }

  // start the heartbeat interval
  startHeartbeat(
    res: IAppResponse,
    signal: AbortSignal,
    interval?: number,
  ): NodeJS.Timeout {
    const heartbeatInterval = interval ?? streamDefaults.heartbeatInterval;

    return setInterval(() => {
      if (!signal.aborted && !res.writableEnded) {
        try {
          res.write(`: heartbeat\n\n`);
        } catch (_error) {
          // ignore write errors - client will ignore this event
        }
      }
    }, heartbeatInterval);
  }
}
