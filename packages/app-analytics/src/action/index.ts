import { isValidApplicationName } from "../core/data-spec";
import type {
  BrowserEvent,
  BrowserEventMetadata,
  EventProperties,
} from "../core/event";
import { normalizeProperties } from "../core/properties";

export const MAX_EVENT_NAME_LENGTH = 128;

export function createActionEvent(
  name: string,
  properties: EventProperties,
  metadata: BrowserEventMetadata,
): BrowserEvent | null {
  const normalizedName = normalizeEventName(name);
  if (normalizedName === null) return null;

  return {
    id: metadata.id,
    name: normalizedName,
    type: "action",
    timestamp: metadata.timestamp,
    properties: normalizeProperties(properties),
    context: metadata.context,
  };
}

export function createAutocapturedActionEvent(
  name: string,
  _interaction: { type: "click" | "submit"; element: string },
  metadata: BrowserEventMetadata,
): BrowserEvent | null {
  const normalizedName = normalizeEventName(name);
  if (normalizedName === null) return null;

  return {
    id: metadata.id,
    name: normalizedName,
    type: "action",
    timestamp: metadata.timestamp,
    properties: {},
    context: metadata.context,
  };
}

function normalizeEventName(name: string): string | null {
  if (typeof name !== "string") return null;

  const normalized = name.trim();
  return normalized === name &&
    normalized.length <= MAX_EVENT_NAME_LENGTH &&
    isValidApplicationName(normalized)
    ? normalized
    : null;
}
