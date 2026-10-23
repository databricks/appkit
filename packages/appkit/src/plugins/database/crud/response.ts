import type { Response } from "express";

import { DatabasePluginError } from "../../../database/errors";
import { MAX_RESPONSE_BYTES } from "../defaults";
import type { JsonValue } from "./codecs";

/**
 * Row data is never cacheable by a shared proxy or a browser: the same URL can
 * answer differently once the underlying table or the caller's rights change.
 */
function writeJson(res: Response, status: number, payload: string): void {
  res.status(status);
  res.type("application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(payload);
}

/** Measure the encoded body before sending so no partial response escapes. */
export function sendJson(res: Response, status: number, body: JsonValue): void {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES) {
    throw new DatabasePluginError("PAYLOAD_TOO_LARGE", "read");
  }
  writeJson(res, status, payload);
}

/** A `204` carries no body but owes the same cache promise as one that does. */
export function sendEmpty(res: Response, status: number): void {
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  res.send();
}
