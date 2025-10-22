import type { IAppResponse } from "@databricks-apps/types";
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
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Content-Encoding", "none");

    res.flushHeaders?.();
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
