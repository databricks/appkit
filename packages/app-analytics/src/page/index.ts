import { APP_ANALYTICS_EVENT_NAMES } from "../core/data-spec";
import type {
  BrowserEvent,
  BrowserEventMetadata,
  DiagnosticSink,
  EventProperties,
} from "../core/event";
import { normalizeProperties } from "../core/properties";

export function createPageViewEvent(
  properties: EventProperties,
  metadata: BrowserEventMetadata,
  report?: DiagnosticSink,
): BrowserEvent {
  return {
    id: metadata.id,
    name: APP_ANALYTICS_EVENT_NAMES.pageView,
    type: "page_view",
    timestamp: metadata.timestamp,
    properties: normalizeProperties(properties, report),
    context: metadata.context,
  };
}
