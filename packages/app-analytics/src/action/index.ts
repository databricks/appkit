import { isValidName, MAX_NAME_LENGTH } from "../core/data-spec";
import type {
  BrowserEvent,
  BrowserEventMetadata,
  DiagnosticSink,
  EventProperties,
} from "../core/event";
import { normalizeProperties } from "../core/properties";

export const MAX_EVENT_NAME_LENGTH = MAX_NAME_LENGTH;

/**
 * Builds an Action. An invalid name drops the event and reports
 * `invalid_event_name`; rejected properties are reported and omitted.
 */
export function createActionEvent(
  name: string,
  properties: EventProperties,
  metadata: BrowserEventMetadata,
  report?: DiagnosticSink,
): BrowserEvent | null {
  if (!isValidName(name)) {
    report?.({ code: "invalid_event_name", eventCount: 1 });
    return null;
  }

  return {
    id: metadata.id,
    name,
    type: "action",
    timestamp: metadata.timestamp,
    properties: normalizeProperties(properties, report),
    context: metadata.context,
  };
}
