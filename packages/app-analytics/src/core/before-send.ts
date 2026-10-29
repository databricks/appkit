import { isValidPagePath } from "./context";
import { isValidName } from "./data-spec";
import type { AppAnalyticsEvent, BrowserEvent, DiagnosticSink } from "./event";
import { normalizeProperties } from "./properties";

/**
 * What `beforeSend` may return:
 *
 * - `false` or `null` drops the event;
 * - `true` or nothing keeps it unchanged;
 * - an event keeps it with the returned `name`, `properties`, and
 *   `context.path`. Only Actions can be renamed; Page View and Web Vital
 *   names are canonical. Every other field is owned by the SDK and ignored.
 */
export type BeforeSendResult =
  | AppAnalyticsEvent
  | boolean
  | null
  | undefined
  | void;

/** Immutable copy handed to `beforeSend`, so the hook cannot mutate queued data. */
export function createEventSnapshot(event: BrowserEvent): AppAnalyticsEvent {
  const context = Object.freeze({ ...event.context });
  const properties = Object.freeze({ ...event.properties });
  const webVital =
    event.webVital === undefined
      ? undefined
      : Object.freeze({ ...event.webVital });
  return Object.freeze({ ...event, context, properties, webVital });
}

/**
 * Applies a `beforeSend` result. A field counts as overridden only when it
 * differs from the snapshot the hook received. Overrides are validated like
 * application input, and an invalid name or path drops the event instead of
 * falling back to the original, so a failed redaction never sends the
 * unredacted value.
 */
export function applyBeforeSendResult(
  event: BrowserEvent,
  snapshot: AppAnalyticsEvent,
  result: BeforeSendResult,
  report: DiagnosticSink,
): BrowserEvent | null {
  if (result === false || result === null) return null;
  if (typeof result !== "object") return event;

  const updated: BrowserEvent = { ...event, context: { ...event.context } };

  if (event.type === "action" && hasOverride(result, "name", snapshot.name)) {
    if (!isValidName(result.name)) {
      report({ code: "invalid_event_name", eventCount: 1 });
      return null;
    }
    updated.name = result.name;
  }

  if (hasOverride(result, "properties", snapshot.properties)) {
    updated.properties = normalizeProperties(result.properties, report);
  }

  const context: unknown = result.context;
  if (
    typeof context === "object" &&
    context !== null &&
    hasOverride(context, "path", snapshot.context.path)
  ) {
    const path: unknown = (context as { path?: unknown }).path;
    if (!isValidPagePath(path)) {
      report({
        code: "before_send_error",
        eventCount: 1,
        reason: "invalid_page_path",
      });
      return null;
    }
    updated.context.path = path;
  }

  return updated;
}

function hasOverride(value: object, key: string, original: unknown): boolean {
  return Object.hasOwn(value, key) && Reflect.get(value, key) !== original;
}
