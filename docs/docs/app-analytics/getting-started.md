---
title: App Analytics
sidebar_label: Getting started
sidebar_position: 1
description: Produce App Analytics data with any conforming producer, and use the browser library for browser collection.
---

import Tabs from "@theme/Tabs";
import TabItem from "@theme/TabItem";

# App Analytics

App Analytics measures product usage and browser experience in Databricks Apps. It is defined by data, not by a library. The Analytics UI reads conforming rows from the Unity Catalog `otel_logs` table.

:::info[Not the Analytics plugin]

App Analytics is browser usage and experience telemetry. The AppKit [Analytics plugin](../plugins/analytics.md) runs SQL queries against a SQL Warehouse. The two are unrelated.

:::

:::note[The contract is independent of the producer]

The [data specification](./api-reference.md) defines the required fields, encoding, validation, and UI behavior. `@databricks/app-analytics` is a browser library that implements it. AppKit is an application framework that hosts the collection route for you. Neither package is required for conformance.

A server can emit an Action associated with an app interaction or forward captured browser observations. Every producer still needs valid event and session context. A sessionless batch job does not satisfy the current envelope merely by sending OTLP.

:::

| Data type | What it answers | Status |
| --- | --- | --- |
| [Action](./events.md#action) | Which product actions happened? | Implemented by the browser library |
| [Page View](./events.md#page-view) | Which routes receive visits? | Implemented by the browser library |
| [Web Vitals](./events.md#web-vital) | What performance did the browser observe? | Implemented by the browser library |

App Analytics is best-effort telemetry, not the authoritative record of a business transaction.

## Set up collection

Choose how to produce the data and then ensure it can reach the Collector. Those are independent decisions.

<Tabs groupId="analytics-producer">
<TabItem value="sdk" label="Using the browser library" default>

The browser library handles event IDs, browser sessions, validation, encoding, batching, and retries.

In an AppKit app, import it from `@databricks/appkit-ui`. The server side needs no code, and when App telemetry is on, AppKit starts the library in every page on its own; see [Using with AppKit](./using-with-appkit.md).

```tsx
import { AppAnalytics } from "@databricks/appkit-ui/react/beta";

export function App() {
  return (
    <>
      <AppAnalytics webVitals />
      <AppRoutes />
    </>
  );
}
```

Page Views start automatically after initialization. Web Vitals are opt-in with `webVitals`. Actions use explicit tracking or annotated interactions.

Without React:

```typescript
import { appAnalytics } from "@databricks/appkit-ui/js/beta";

appAnalytics.init({ webVitals: true });
```

The library posts to the same-origin path `/_analytics/v1/logs` by default. The AppKit server plugin serves that path. An app built without AppKit must provide its own route there, or pass a different same-origin `endpoint`.

The standalone `@databricks/app-analytics` package, with the same API under `@databricks/app-analytics` and `@databricks/app-analytics/react`, is not published on its own yet.

</TabItem>
<TabItem value="data" label="Producing the data yourself">

Emit the same contract with any suitable runtime. This is the structural OTLP payload for one Action:

```json
{
  "resourceLogs": [
    {
      "scopeLogs": [
        {
          "scope": { "name": "my-producer" },
          "logRecords": [
            {
              "timeUnixNano": "1740000000000000000",
              "eventName": "report_exported",
              "attributes": [
                {
                  "key": "databricks.app.analytics.schema.version",
                  "value": { "intValue": "1" }
                },
                {
                  "key": "databricks.app.analytics.event.id",
                  "value": { "stringValue": "event-1" }
                },
                {
                  "key": "databricks.app.analytics.event.type",
                  "value": { "stringValue": "action" }
                },
                {
                  "key": "databricks.app.analytics.event.name",
                  "value": { "stringValue": "report_exported" }
                },
                {
                  "key": "databricks.app.analytics.session.id",
                  "value": { "stringValue": "session-1" }
                },
                {
                  "key": "databricks.app.analytics.properties.format",
                  "value": { "stringValue": "csv" }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

The IDs and historical timestamp are illustrative. For a new event, generate a globally unique event ID, use the actual event time, and preserve a valid originating analytics session. A replay of an existing event keeps its original ID and content.

OTLP integers are JSON strings; doubles are JSON numbers. See [Wire format](./api-reference.md#wire-format) for encoding and validation details.

</TabItem>
</Tabs>

### Provide the path to the Collector

Browser producers need a same-origin forwarding route, because the OTel Collector of a Databricks App listens only on `localhost` inside the app:

```text
browser -> /_analytics/v1/logs in your app -> OTel Collector -> otel_logs
```

The producer constructs and validates its data. The relay forwards the OTLP body; it does not define, clean, or interpret the App Analytics schema.

Every AppKit app already has this route: the server plugin relays `POST /_analytics/v1/logs` to the Collector. See [Using with AppKit](./using-with-appkit.md). An app built on a different server framework mounts the same route itself; see the [reference relay](./architecture.md#the-browser-forwarding-endpoint).

Records reach `otel_logs` only when App telemetry is enabled for the app. See [App telemetry](./using-with-appkit.md#turn-on-app-telemetry).

Server-side exporters send to the Collector through their configured server transport without a browser same-origin hop. See [Producer topologies](./architecture.md#producer-topologies).

## Track your first Action

<Tabs groupId="analytics-producer">
<TabItem value="sdk" label="Using the browser library" default>

```typescript
appAnalytics.track("report_exported", { format: "csv", rows: 1240 });
```

</TabItem>
<TabItem value="data" label="The data it sends">

```text
schema_version = 1
event_id       = "event-1"
event_type     = "action"
event_name     = "report_exported"
session_id     = "session-1"
page_path      = "/reports"
properties     = { "format": "csv", "rows": 1240 }
occurred_at    = <event time>
```

These logical fields map to one OTLP record. A different producer supplies the same values and owns their identity and lifecycle. The specification defines the [exact mapping](./api-reference.md#mvp-encoding-in-otel_logs).

</TabItem>
</Tabs>

Use a reusable event name and put varying details in properties. `report_exported` with `format="csv"` is easier to query than a different event name for each format.

## Verify it works

1. Open the deployed app with the browser network panel visible.
2. Look for the `POST /_analytics/v1/logs` request. The library batches after five seconds or 25 events.
3. Inspect the JSON for the `databricks.app.analytics.*` attributes.
4. In a test, call `await appAnalytics.flush()` to finish a bounded drain attempt without waiting for the batch timer. This is not an ingestion acknowledgement.
5. Query the configured `otel_logs` source after allowing for ingestion delay.

```sql
SELECT
  time AS occurred_at,
  attributes['databricks.app.analytics.event.type']::STRING AS event_type,
  attributes['databricks.app.analytics.event.name']::STRING AS event_name
FROM otel_logs
WHERE attributes['databricks.app.analytics.schema.version']::INT = 1
ORDER BY occurred_at DESC
LIMIT 20;
```

This diagnostic query shows received rows, including ones that might not pass full UI validation. If data is missing, check the endpoint, delivery, ingestion, selected source, and event time. Then check the [validation rules](./api-reference.md#2-spec). Appearance in this query alone is not proof of conformance.

## What must never be collected

The specification forbids user emails, usernames, IP addresses, credentials, cookies, raw DOM, element text, form values, full query strings, and fragments in event payloads. V1 has no authoritative user identity.

This is a producer obligation. The browser library rejects reserved keys, but arbitrary application property values and concrete URL paths still need care. See [Trusted context and privacy](./api-reference.md#trusted-context-and-privacy).

## Where to next

- [Using with AppKit](./using-with-appkit.md): mount the library in an AppKit app and let the server plugin relay its records.
- [Architecture](./architecture.md): the data path, producer boundaries, delivery behavior, and a reference relay for apps built without AppKit.
- [Events](./events.md): the three data types and examples of what each produces.
- [Data specification](./api-reference.md): the normative proposal, independent of producer library.
