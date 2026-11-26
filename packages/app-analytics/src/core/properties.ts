import { MAX_NAME_LENGTH, propertyNameIssue } from "./data-spec";
import type {
  DiagnosticSink,
  EventProperties,
  EventPropertyValue,
} from "./event";

export const MAX_PROPERTY_COUNT = 50;
export const MAX_PROPERTY_NAME_LENGTH = MAX_NAME_LENGTH;
export const MAX_STRING_VALUE_LENGTH = 1_024;

type PropertyDropReason =
  | "invalid_name"
  | "invalid_value"
  | "limit_exceeded"
  | "sensitive_name";

/**
 * Keeps scalar properties with accepted keys, up to {@link MAX_PROPERTY_COUNT}.
 * Nullish values are omitted silently; every other omission is reported as one
 * `property_dropped` diagnostic per reason, with counts and no keys or values.
 */
export function normalizeProperties(
  properties: EventProperties,
  report?: DiagnosticSink,
): Record<string, EventPropertyValue> {
  if (!isRecord(properties)) return {};

  const normalized: Record<string, EventPropertyValue> = {};
  const dropped = new Map<PropertyDropReason, number>();
  let propertyCount = 0;

  for (const key in properties) {
    if (!Object.hasOwn(properties, key)) continue;

    const value = properties[key];
    if (value === null || value === undefined) continue;

    const reason: PropertyDropReason | undefined =
      propertyNameIssue(key) ??
      (isEventPropertyValue(value) ? undefined : "invalid_value") ??
      (propertyCount >= MAX_PROPERTY_COUNT ? "limit_exceeded" : undefined);
    if (reason !== undefined) {
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      continue;
    }

    normalized[key] = value as EventPropertyValue;
    propertyCount += 1;
  }

  for (const [reason, count] of dropped) {
    report?.({
      code: "property_dropped",
      eventCount: 1,
      propertyCount: count,
      reason,
    });
  }

  return normalized;
}

function isEventPropertyValue(value: unknown): value is EventPropertyValue {
  return (
    (typeof value === "string" && value.length <= MAX_STRING_VALUE_LENGTH) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
