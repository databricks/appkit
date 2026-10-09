import type { IAppResponse } from "shared";

import { streamDefaults } from "./defaults";
import {
  type BufferedEvent,
  type SSEError,
  SSEErrorCode,
  SSEWarningCode,
} from "./types";
import { StreamValidator } from "./validator";

/**
 * `JSON.stringify` replacer for SSE events: the modular SDK returns int64 fields
 * as `bigint`, which `JSON.stringify` throws on. Emit them as numbers, matching
 * what the legacy SDK's raw JSON produced.
 */
export function sseJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

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
  }

  // write a single event to the response
  writeEvent(res: IAppResponse, eventId: string, event: any): void {
    if (res.writableEnded) return;

    const eventType = StreamValidator.sanitizeEventType(event.type);
    const eventData = JSON.stringify(event, sseJsonReplacer);

    res.write(`id: ${eventId}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${eventData}\n\n`);
  }
  writeError(
    res: IAppResponse,
    eventId: string,
    error: string,
    code: SSEErrorCode = SSEErrorCode.INTERNAL_ERROR,
    errorCode?: string,
  ): void {
    if (res.writableEnded) return;

    const errorData: SSEError = {
      error,
      code,
      ...(errorCode ? { errorCode } : {}),
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
