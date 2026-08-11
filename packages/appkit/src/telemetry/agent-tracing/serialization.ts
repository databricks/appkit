import { createHash } from "node:crypto";
import {
  DEFAULT_TRACE_REDACT_KEYS,
  DEFAULT_TRACE_VALUE_MAX_BYTES,
  REDACTED_TRACE_VALUE,
} from "./attributes";
import type { CapturedTraceValue, CaptureTraceValueOptions } from "./types";

export function captureTraceValue(
  value: unknown,
  options: CaptureTraceValueOptions = {},
): CapturedTraceValue {
  const redactKeys = new Set(
    [...DEFAULT_TRACE_REDACT_KEYS, ...(options.redactKeys ?? [])].map((key) =>
      key.toLowerCase(),
    ),
  );
  const serialized =
    JSON.stringify(value, (key, current) => {
      if (redactKeys.has(key.toLowerCase())) return REDACTED_TRACE_VALUE;
      if (
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
      ) {
        return Object.fromEntries(
          Object.keys(current)
            .sort()
            .map((objectKey) => [
              objectKey,
              (current as Record<string, unknown>)[objectKey],
            ]),
        );
      }
      return current;
    }) ?? "null";

  const encoded = Buffer.from(serialized, "utf8");
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const retained = truncateUtf8(encoded, maxBytes);

  return {
    value: retained.toString("utf8"),
    originalBytes: encoded.length,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    truncated: retained.length < encoded.length,
  };
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRACE_VALUE_MAX_BYTES;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("maxBytes must be a finite, non-negative number");
  }
  return Math.floor(value);
}

function truncateUtf8(value: Buffer, maxBytes: number): Buffer {
  if (value.length <= maxBytes) return value;

  let end = maxBytes;
  while (end > 0 && (value[end] & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end);
}
