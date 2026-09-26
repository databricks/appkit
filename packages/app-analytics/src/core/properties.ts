import { isValidPropertyName } from "./data-spec";
import type { EventProperties, EventPropertyValue } from "./event";

export const MAX_PROPERTY_COUNT = 50;
export const MAX_PROPERTY_NAME_LENGTH = 128;
export const MAX_STRING_VALUE_LENGTH = 1_024;

export function normalizeProperties(
  properties: EventProperties,
): Record<string, EventPropertyValue> {
  if (!isRecord(properties)) return {};

  const normalized: Record<string, EventPropertyValue> = {};
  let propertyCount = 0;

  for (const key in properties) {
    if (propertyCount >= MAX_PROPERTY_COUNT) break;
    if (!Object.hasOwn(properties, key)) continue;

    const value = properties[key];
    if (isReservedProperty(key) || !isEventPropertyValue(value)) continue;
    normalized[key] = value;
    propertyCount += 1;
  }

  return normalized;
}

function isReservedProperty(key: string): boolean {
  return (
    key.trim().length === 0 ||
    key !== key.trim() ||
    key.length > MAX_PROPERTY_NAME_LENGTH ||
    !isValidPropertyName(key)
  );
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
