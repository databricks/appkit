import {
  APP_ANALYTICS_ATTRIBUTE_NAMES,
  APP_ANALYTICS_SCHEMA_VERSION,
  applicationPropertyAttributeName,
} from "./data-spec";
import type { BrowserEvent, EventPropertyValue } from "./event";

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  eventName: string;
  severityText?: "INFO";
  severityNumber?: 9;
  body?: { stringValue: string };
  attributes: OtlpKeyValue[];
}

export interface ExportLogsServiceRequest {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string; version: string };
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

export function encodeOtlp(
  events: readonly BrowserEvent[],
): ExportLogsServiceRequest {
  const firstEvent = events[0];
  if (firstEvent === undefined) return { resourceLogs: [] };

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("telemetry.sdk.name", firstEvent.context.sdkName),
            attribute("telemetry.sdk.language", "webjs"),
            attribute("telemetry.sdk.version", firstEvent.context.sdkVersion),
          ],
        },
        scopeLogs: [
          {
            scope: {
              name: firstEvent.context.sdkName,
              version: firstEvent.context.sdkVersion,
            },
            logRecords: events.map(encodeLogRecord),
          },
        ],
      },
    ],
  };
}

function encodeLogRecord(event: BrowserEvent): OtlpLogRecord {
  const timeUnixNano = (
    BigInt(Math.trunc(event.timestamp)) * 1_000_000n
  ).toString();
  const propertyAttributes = Object.entries(event.properties)
    .sort(([left], [right]) => compareAttributeNames(left, right))
    .map(([key, value]) =>
      attribute(applicationPropertyAttributeName(key), value),
    );

  const attributes = [
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.eventId, event.id),
    attribute(
      APP_ANALYTICS_ATTRIBUTE_NAMES.schemaVersion,
      APP_ANALYTICS_SCHEMA_VERSION,
    ),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.eventType, event.type),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.eventName, event.name),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.sessionId, event.context.sessionId),
    ...(event.context.path === ""
      ? []
      : [
          attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.pagePath, event.context.path),
        ]),
    ...webVitalAttributes(event),
    ...propertyAttributes,
  ];

  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    eventName: event.name,
    ...standardRecordFields(attributes),
    attributes,
  };
}

const BODY_FIELDS = [
  ["schema_version", APP_ANALYTICS_ATTRIBUTE_NAMES.schemaVersion],
  ["event_id", APP_ANALYTICS_ATTRIBUTE_NAMES.eventId],
  ["event_type", APP_ANALYTICS_ATTRIBUTE_NAMES.eventType],
  ["event_name", APP_ANALYTICS_ATTRIBUTE_NAMES.eventName],
  ["session_id", APP_ANALYTICS_ATTRIBUTE_NAMES.sessionId],
  ["page_path", APP_ANALYTICS_ATTRIBUTE_NAMES.pagePath],
  ["web_vital_value", APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalValue],
  ["web_vital_unit", APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalUnit],
  ["web_vital_delta", APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalDelta],
  ["web_vital_sample_id", APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalSampleId],
  ["web_vital_rating", APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalRating],
  [
    "web_vital_navigation_type",
    APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalNavigationType,
  ],
] as const;

/** Build the readable MVP body from the encoded attributes, never the raw event. */
function standardRecordFields(
  attributes: readonly OtlpKeyValue[],
): Pick<OtlpLogRecord, "severityText" | "severityNumber" | "body"> {
  const values = new Map(
    attributes.map(({ key, value }) => [key, scalarValue(value)]),
  );
  const logical: Record<
    string,
    EventPropertyValue | Record<string, EventPropertyValue>
  > = {};
  for (const [field, key] of BODY_FIELDS) {
    const value = values.get(key);
    if (value !== undefined) logical[field] = value;
  }
  const prefix = APP_ANALYTICS_ATTRIBUTE_NAMES.propertyPrefix;
  const properties = Object.fromEntries(
    [...values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
  if (Object.keys(properties).length > 0) logical.properties = properties;

  return {
    severityText: "INFO",
    severityNumber: 9,
    body: { stringValue: JSON.stringify(logical) },
  };
}

function scalarValue(value: OtlpAnyValue): EventPropertyValue {
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  return value.boolValue;
}

function webVitalAttributes(event: BrowserEvent): OtlpKeyValue[] {
  const vital = event.webVital;
  if (event.type !== "web_vital" || vital === undefined) return [];

  return [
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalValue, vital.value),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalUnit, vital.unit),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalDelta, vital.delta),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalSampleId, vital.sampleId),
    attribute(APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalRating, vital.rating),
    ...(vital.navigationType === undefined
      ? []
      : [
          attribute(
            APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalNavigationType,
            vital.navigationType,
          ),
        ]),
  ];
}

function compareAttributeNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function attribute(key: string, value: EventPropertyValue): OtlpKeyValue {
  return { key, value: toOtlpValue(key, value) };
}

function toOtlpValue(key: string, value: EventPropertyValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (
    key === APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalValue ||
    key === APP_ANALYTICS_ATTRIBUTE_NAMES.webVitalDelta
  ) {
    return { doubleValue: value };
  }
  if (Number.isSafeInteger(value)) return { intValue: value.toString() };
  return { doubleValue: value };
}
