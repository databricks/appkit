import { describe, expect, it } from "vitest";

import { createActionEvent } from "../action";
import type {
  BrowserEvent,
  BrowserEventMetadata,
  EventProperties,
} from "../core/event";
import { SDK_NAME, SDK_VERSION } from "../core/event";
import { encodeOtlp } from "../core/otlp-json";
import { createPageViewEvent } from "../page";
import { createWebVitalEvent } from "../web-vitals";
import { readFirstLogRecord } from "./test-utils";

describe("OTLP JSON encoding", () => {
  it("encodes a deterministic App Analytics v1 fixture", () => {
    const event: BrowserEvent = {
      id: "event-1",
      name: "order_exported",
      type: "action",
      timestamp: 1_740_000_000_000,
      properties: {
        rows: 1240,
        score: 1.25,
        format: "csv",
        compressed: true,
      },
      context: {
        sessionId: "session-1",
        path: "/orders/42",
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
      },
    };

    expect(encodeOtlp([event])).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "telemetry.sdk.name",
                value: { stringValue: "@databricks/app-analytics" },
              },
              {
                key: "telemetry.sdk.language",
                value: { stringValue: "webjs" },
              },
              {
                key: "telemetry.sdk.version",
                value: { stringValue: SDK_VERSION },
              },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: "@databricks/app-analytics",
                version: SDK_VERSION,
              },
              logRecords: [
                {
                  timeUnixNano: "1740000000000000000",
                  observedTimeUnixNano: "1740000000000000000",
                  eventName: "order_exported",
                  severityText: "INFO",
                  severityNumber: 9,
                  body: {
                    stringValue: JSON.stringify({
                      schema_version: 1,
                      event_id: "event-1",
                      event_type: "action",
                      event_name: "order_exported",
                      session_id: "session-1",
                      page_path: "/orders/42",
                      properties: {
                        compressed: true,
                        format: "csv",
                        rows: 1240,
                        score: 1.25,
                      },
                    }),
                  },
                  attributes: [
                    {
                      key: "databricks.app.analytics.event.id",
                      value: { stringValue: "event-1" },
                    },
                    {
                      key: "databricks.app.analytics.schema.version",
                      value: { intValue: "1" },
                    },
                    {
                      key: "databricks.app.analytics.event.type",
                      value: { stringValue: "action" },
                    },
                    {
                      key: "databricks.app.analytics.event.name",
                      value: { stringValue: "order_exported" },
                    },
                    {
                      key: "databricks.app.analytics.session.id",
                      value: { stringValue: "session-1" },
                    },
                    {
                      key: "databricks.app.analytics.page.path",
                      value: { stringValue: "/orders/42" },
                    },
                    {
                      key: "databricks.app.analytics.properties.compressed",
                      value: { boolValue: true },
                    },
                    {
                      key: "databricks.app.analytics.properties.format",
                      value: { stringValue: "csv" },
                    },
                    {
                      key: "databricks.app.analytics.properties.rows",
                      value: { intValue: "1240" },
                    },
                    {
                      key: "databricks.app.analytics.properties.score",
                      value: { doubleValue: 1.25 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("returns an empty OTLP request for an empty batch", () => {
    expect(encodeOtlp([])).toEqual({ resourceLogs: [] });
  });

  it("encodes the canonical Page View name and classification", () => {
    const event: BrowserEvent = {
      id: "page-view-1",
      name: "page_view",
      type: "page_view",
      timestamp: 1_740_000_000_000,
      properties: {},
      context: {
        sessionId: "session-1",
        path: "/dashboard",
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
      },
    };

    const record = encodeOtlp([event]).resourceLogs[0]?.scopeLogs[0]
      ?.logRecords[0];

    expect(record?.eventName).toBe("page_view");
    expect(record?.attributes).toContainEqual({
      key: "databricks.app.analytics.event.name",
      value: { stringValue: "page_view" },
    });
    expect(record?.attributes).toContainEqual({
      key: "databricks.app.analytics.event.type",
      value: { stringValue: "page_view" },
    });
    expect(record).toMatchObject({ severityText: "INFO", severityNumber: 9 });
    expect(JSON.parse(record?.body?.stringValue ?? "null")).toEqual({
      schema_version: 1,
      event_id: "page-view-1",
      event_type: "page_view",
      event_name: "page_view",
      session_id: "session-1",
      page_path: "/dashboard",
    });
  });

  it.each([
    ["TTFB", 1000, "ms"],
    ["FCP", 2000, "ms"],
    ["LCP", 3000, "ms"],
    ["INP", 300, "ms"],
    ["CLS", 0.2, "score"],
    ["CLS", 0, "score"],
  ] as const)(
    "mirrors all typed %s fields in the JSON body at value %s",
    (name, value, unit) => {
      const event = createWebVitalEvent(
        {
          name,
          value,
          delta: 0,
          id: "opaque-sample-1",
          rating: value === 0 ? "good" : "needs-improvement",
          navigationType: "back-forward-cache",
        },
        metadata(),
      );
      if (event === null) throw new Error("Expected a valid Web Vital");
      const record = readFirstLogRecord(encodeOtlp([event]));
      expect(record).toMatchObject({ severityText: "INFO", severityNumber: 9 });
      expect(JSON.parse(record.body?.stringValue ?? "null")).toEqual({
        schema_version: 1,
        event_id: event.id,
        event_type: "web_vital",
        event_name: name.toLowerCase(),
        session_id: "session-1",
        page_path: "/dashboard",
        web_vital_value: value,
        web_vital_unit: unit,
        web_vital_delta: 0,
        web_vital_sample_id: "opaque-sample-1",
        web_vital_rating: value === 0 ? "good" : "needs_improvement",
        web_vital_navigation_type: "back_forward_cache",
      });
      expect(record.attributes).toContainEqual({
        key: "databricks.app.analytics.web_vital.value",
        value: { doubleValue: value },
      });
      expect(record.attributes).toContainEqual({
        key: "databricks.app.analytics.web_vital.delta",
        value: { doubleValue: 0 },
      });
    },
  );

  it("omits absent path, properties and optional navigation type instead of inventing values", () => {
    const base = metadata();
    base.context.path = "";
    const event = createWebVitalEvent(
      {
        name: "FCP",
        value: 0,
        delta: 0,
        id: "sample-1",
        rating: "good",
        navigationType: "soft-navigation",
      },
      base,
    );
    if (event === null) throw new Error("Expected a valid Web Vital");
    const record = readFirstLogRecord(encodeOtlp([event]));
    const body = JSON.parse(record.body?.stringValue ?? "null");
    expect(body).not.toHaveProperty("page_path");
    expect(body).not.toHaveProperty("properties");
    expect(body).not.toHaveProperty("web_vital_navigation_type");
    expect(body.web_vital_value).toBe(0);
    expect(
      record.attributes.some(
        ({ key }) =>
          key.endsWith("navigation_type") || key.endsWith("page.path"),
      ),
    ).toBe(false);
  });

  it.each(["action", "page_view"] as const)(
    "mirrors only normalized %s properties, retaining false, zero and escaped strings",
    (type) => {
      const properties = {
        selected_window: "24h",
        enabled: false,
        count: 0,
        ratio: 1.25,
        format: 'quoted "csv"\\\nformat',
        missing: null,
        omitted: undefined,
        email: "PRIVATE_EMAIL_SENTINEL",
        access_token: "PRIVATE_TOKEN_SENTINEL",
        nested: { value: "PRIVATE_NESTED_SENTINEL" },
      } as unknown as EventProperties;
      const event =
        type === "action"
          ? createActionEvent("demo_interaction", properties, metadata())
          : createPageViewEvent(properties, metadata());
      if (event === null) throw new Error("Expected a valid event");
      const original = structuredClone(event);
      const payload = encodeOtlp([event]);
      const record = readFirstLogRecord(payload);
      const body = JSON.parse(record.body?.stringValue ?? "null");
      expect(body.properties).toEqual({
        count: 0,
        enabled: false,
        format: 'quoted "csv"\\\nformat',
        ratio: 1.25,
        selected_window: "24h",
      });
      expect(body).not.toHaveProperty("web_vital_value");
      expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
      expect(event).toEqual(original);
      expect(encodeOtlp([event])).toEqual(payload);
    },
  );

  it("does not serialize raw event/context/metric extras or fabricate an app instance", () => {
    const event = createWebVitalEvent(
      {
        name: "CLS",
        value: 0,
        delta: 0,
        id: "sample-1",
        rating: "good",
        navigationType: "navigate",
      },
      metadata(),
    );
    if (event === null || event.webVital === undefined)
      throw new Error("Expected a valid Web Vital");
    Object.assign(event, { rawResult: "PRIVATE_RAW_RESULT" });
    Object.assign(event.context, {
      url: "PRIVATE_URL",
      instanceId: "PRIVATE_INSTANCE",
    });
    Object.assign(event.webVital, {
      entries: [{ target: "PRIVATE_DOM" }],
      rawError: "PRIVATE_ERROR",
    });
    const payload = encodeOtlp([event]);
    const record = readFirstLogRecord(payload);
    const body = JSON.parse(record.body?.stringValue ?? "null");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_");
    expect(JSON.stringify(payload)).not.toContain("app.instance_id");
    for (const key of [
      "context",
      "timestamp",
      "sdkName",
      "sdkVersion",
      "rawResult",
      "webVital",
      "entries",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.web_vital_value).toBe(0);
  });
});

function metadata(): BrowserEventMetadata {
  return {
    id: "event-1",
    timestamp: 1_740_000_000_000,
    context: {
      sessionId: "session-1",
      path: "/dashboard",
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
    },
  };
}
