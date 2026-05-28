/**
 * SSE wire format for the task bridge. Uses the engine `streamSeq` as
 * the SSE `id:` so client `Last-Event-ID` reconnects resume from the WAL.
 */
import type { Response } from "express";

/**
 * Event names the bridge writes itself, or that collide with engine
 * terminal frames. Plugin code must NOT emit these via `ctx.emit` —
 * `event: completed` would close the EventSource on the client.
 * @internal
 */
export const RESERVED_BRIDGE_EVENT_NAMES = new Set<string>([
  // Bridge-internal frames.
  "ready",
  "error",
  // Engine wire vocabulary.
  "heartbeat",
  "completed",
  "failed",
  "cancelled",
  "suspended",
]);

/**
 * SSE frame. `data` is pre-serialised so callers can emit JSON, plain
 * text, or anything else without the writer touching the payload.
 * @public
 */
export interface SseEvent {
  /** SSE `event:` field name (e.g. "tick", "completed", "data"). */
  event: string;
  /** Pre-serialised payload for the SSE `data:` field. */
  data: string;
  /**
   * Optional SSE `id:` echoed back via `Last-Event-ID` on reconnect.
   * The bridge sets it to the engine `streamSeq`.
   */
  id?: string | number;
}

/**
 * SSE injection guard: event names live on a single line, so embedded
 * CR/LF would let an attacker close one event and start another. Refuse
 * rather than strip — caller has a bug to fix.
 * @internal
 */
function assertSafeEventName(name: string): void {
  if (/[\r\n]/.test(name)) {
    throw new Error(
      `SSE event name must not contain CR/LF: ${JSON.stringify(name)}`,
    );
  }
}

/** Same rationale as {@link assertSafeEventName}. @internal */
function assertSafeId(id: string | number): void {
  if (typeof id === "number") return;
  if (/[\r\n]/.test(id)) {
    throw new Error(`SSE id must not contain CR/LF: ${JSON.stringify(id)}`);
  }
}

/**
 * Re-encode `data` as one or more `data:` lines per the SSE spec.
 * EventSource joins them with `\n`, so multi-line payloads round-trip
 * losslessly while every wire line still starts with `data:` (denies
 * the "embedded CRLF dispatches a synthetic event" attack).
 * @internal
 */
function formatDataField(data: string): string {
  return data
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
}

/**
 * Writes the SSE handshake (200 + content type + cache controls).
 * `flushHeaders()` so intermediaries see the response start before the
 * first event lands. `Vary: Origin` so a CDN that caches an SSE
 * response (despite `no-cache`) cannot serve it cross-origin.
 * @public
 */
export function setupSseHeaders(res: Response): void {
  if (res.headersSent) return;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  // Disables nginx-style proxy buffering used by Cloudflare / AWS / GCP.
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Vary", "Origin");
  res.flushHeaders?.();
}

/**
 * Writes one SSE frame. Returns `false` once the response has ended so
 * callers can break out of the subscribe loop. Throws on CR/LF in
 * `event` / `id` (header-injection style).
 * @public
 */
export function writeSseFrame(res: Response, frame: SseEvent): boolean {
  if (res.writableEnded) return false;
  assertSafeEventName(frame.event);
  if (frame.id !== undefined && frame.id !== null) {
    assertSafeId(frame.id);
    res.write(`id: ${frame.id}\n`);
  }
  res.write(`event: ${frame.event}\n`);
  res.write(`${formatDataField(frame.data)}\n\n`);
  return true;
}

/**
 * Writes an SSE comment (`: <text>\n\n`). Ignored by EventSource but
 * keeps the connection alive through proxies that drop idle sockets.
 * Used by the bridge to translate engine `heartbeat` into wire
 * keep-alives without surfacing them as application events.
 * @internal
 */
export function writeSseComment(res: Response, text: string): boolean {
  if (res.writableEnded) return false;
  res.write(`: ${text}\n\n`);
  return true;
}
