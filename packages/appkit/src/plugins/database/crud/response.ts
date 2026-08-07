import type { Response } from "express";
import {
  classifyDatabaseError,
  type DatabaseErrorDetail,
  DatabasePluginError,
} from "../../../database/errors";
import { DatabaseValidationError } from "../../../errors";
import { MAX_RESPONSE_BYTES } from "../defaults";
import type { JsonValue } from "./codecs";
import type { CrudTable } from "./contract";

/** Low-cardinality span outcome for one failed generated route. */
export function routeOutcome(
  error: unknown,
): "not_found" | "rejected" | "failed" {
  const statusCode =
    error instanceof DatabaseValidationError
      ? error.statusCode
      : classifyDatabaseError(error, "read").statusCode;
  if (statusCode === 404) return "not_found";
  return statusCode < 500 ? "rejected" : "failed";
}

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

/**
 * Convert a failure into its safe category. A hook's deliberate validation
 * error is the one signal that reaches the caller, and only through the issues
 * naming a public column of this table.
 */
function safeError(
  table: CrudTable,
  phase: "read" | "write",
  error: unknown,
): DatabasePluginError {
  if (!(error instanceof DatabaseValidationError)) {
    return classifyDatabaseError(error, phase);
  }
  const details = error.issues
    .filter(
      (issue) => issue.path.length > 0 && table.selectable.has(issue.path[0]),
    )
    .map((issue) => ({ path: [...issue.path], message: issue.message }));
  return new DatabasePluginError(
    "VALIDATION_FAILED",
    phase,
    undefined,
    details,
  );
}

/** Answer with the failure's safe category and the field it concerns. */
export function sendError(
  res: Response,
  table: CrudTable,
  phase: "read" | "write",
  error: unknown,
): void {
  if (res.headersSent) return;
  const safe = safeError(table, phase, error);
  const body: { error: string; details?: readonly DatabaseErrorDetail[] } = {
    error: safe.clientMessage,
  };
  if (safe.details && safe.details.length > 0) body.details = safe.details;
  const payload = JSON.stringify(body);
  // A failure owes the same byte budget, and its details are what can grow.
  writeJson(
    res,
    safe.statusCode,
    Buffer.byteLength(payload, "utf8") > MAX_RESPONSE_BYTES
      ? JSON.stringify({ error: safe.clientMessage })
      : payload,
  );
}
