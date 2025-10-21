import type { IAppResponse } from "@databricks-apps/types";
import { type BufferedEvent, SSEWarningCode } from "./types";
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

  // write an event to the response
  writeEvent(res: IAppResponse, eventId: string, event: any): void {
    if (res.writableEnded) return;

    const eventType = StreamValidator.sanitizeEventType(event.type);
    const eventData = JSON.stringify(event);

    res.write(`id: ${eventId}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${eventData}\n\n`);
  }

  writeRawEvent(res: IAppResponse, event: BufferedEvent): void {
    if (res.writableEnded) return;

    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${event.data}\n\n`);
  }

  // write an error event to the response
  writeError(res: IAppResponse, eventId: string, errorMessage: string): void {
    if (res.writableEnded) return;

    res.write(`id: ${eventId}\n`);
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  }

  // write a buffer overflow warning event to the response
  writeBufferOverflowWarning(res: IAppResponse, lastEventId: string): void {
    if (res.writableEnded) return;

    try {
      res.write(`event: warning\n`);
      res.write(
        `data: ${JSON.stringify({
          warning:
            "Buffer overflow detected - restarting stream from beginning",
          code: SSEWarningCode.BUFFER_OVERFLOW_RESTART,
          lastEventId,
        })}\n\n`,
      );
    } catch (_error) {
      // ignore write errors
    }
  }

  startHeartbeat(res: IAppResponse, signal: AbortSignal): NodeJS.Timeout {
    return setInterval(() => {
      if (!signal.aborted && !res.writableEnded) {
        try {
          res.write(": heartbeat\n\n");
        } catch (_error) {
          // ignore write errors
        }
      }
    }, 15000);
  }
}
