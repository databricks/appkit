---
title: App Analytics architecture
sidebar_label: Architecture
sidebar_position: 3
description: The App Analytics data path, producer responsibilities, the browser forwarding endpoint, and browser delivery.
---

# App Analytics architecture

App Analytics is defined by the data that reaches the OTel Collector. The `@databricks/app-analytics` package is a browser library that implements the contract; it is not the contract itself.

## The pipeline

```text
producer
    -> OTel Collector
    -> Unity Catalog otel_logs
    -> Analytics UI
```

| Stage | Responsibility |
| --- | --- |
| Producer | Construct, validate, and bound records according to the data specification. |
| OTel Collector | Transport the data. It does not implement App Analytics validation or cleanup. |
| `otel_logs` | Store the records in existing columns and attributes. Delivery may create duplicate physical rows. |
| Analytics UI | Validate rows, deduplicate, reduce Web Vital samples, then interpret the data. |

The MVP creates no additional canonical table or view. The [data specification](./api-reference.md) defines how logical fields map to the existing `otel_logs` source for the selected app.

## What is contract and what is convenience

| Piece | Status | What changes without it |
| --- | --- | --- |
| Data-spec conformance | Contract | Invalid rows are excluded from App Analytics queries. |
| Collector to `otel_logs` | MVP data path | The UI needs the configured telemetry source to read. |
| `@databricks/app-analytics` | Browser implementation | Another producer owns event IDs, session context, validation, encoding, and delivery. |
| AppKit | Application framework | Another server can host the same forwarding endpoint. |

The producer's language does not affect validity. Its runtime still limits what it can measure: Web Vitals require observations of a real browser page. A server can forward those observations, but cannot manufacture them from server timings or static HTML and call them the same measurement.

Instrumentation scope identifies the producer. It is not the schema version and does not establish conformance by itself.

## Producer topologies

**Browser to app to Collector.** The browser library posts OTLP/HTTP JSON to a same-origin path. The app route forwards the body to the Collector. Construction, cleanup, validation, and aggregation remain producer responsibilities.

**Backend to Collector.** A server can emit an Action associated with an originating app interaction, retaining its valid analytics session context. Same-origin restrictions do not apply to this server-side hop.

**Backfill to Collector.** A job can replay captured events while retaining their original occurrence time, session context, and event IDs. Replaying identical data does not create new events.

V1 requires a valid `session_id` on every row. A standalone job with no originating app session does not become valid by omitting that field or copying its job ID into it. Supporting sessionless server activity requires a separate contract decision. See [Session](./api-reference.md#session).

## The browser forwarding endpoint

The typical browser path is:

```text
Browser library -> same-origin relay (/_analytics/v1/logs) -> OTel Collector
```

The OTel Collector of a Databricks App listens only on `localhost` inside the app, so the browser can't reach it directly. The app's own server relays each batch.

The library resolves `endpoint` against `window.location`. It defaults to `/_analytics/v1/logs`. A cross-origin URL or a URL containing credentials falls back to the default.

The relay forwards the OTLP JSON bytes it receives and returns the upstream status. It checks only the OTLP envelope; it does not interpret the App Analytics schema, clean properties, or add authoritative user identity. Normal app authentication still applies to requests. Neither the browser nor a URL parameter chooses the Collector credentials.

### In an AppKit app

The AppKit `server()` plugin serves `POST /_analytics/v1/logs` out of the box. There is no server code to write. When App telemetry is on, it also adds a script tag for `/_analytics/v1/sdk.js`, a self-contained build of the library, to every `index.html` it serves, so the library starts with no client code. See [Using with AppKit](./using-with-appkit.md).

### Reference relay for apps built without AppKit

Adding the browser library alone does not install a server route. An app built on another server framework mounts one itself. This plain Express route mirrors what AppKit does:

```ts
import express from "express";

const APP_ANALYTICS_PATH = "/_analytics/v1/logs";
const FORWARD_TIMEOUT_MS = 5_000;
// The library sends at most 25 records and 48 KiB per request.
const MAX_RECORDS = 100;

// Databricks Apps sets these only when App telemetry is enabled.
function resolveOtlpLogsEndpoint(): string | undefined {
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) return logsEndpoint;

  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!baseEndpoint) return undefined;

  return `${baseEndpoint.replace(/\/$/, "")}/v1/logs`;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects in `value[key]`, or undefined when it isn't an array of objects. */
function objectsIn(value: Json, key: string): Json[] | undefined {
  const items = value[key] ?? [];
  return Array.isArray(items) && items.every(isObject) ? items : undefined;
}

/** Log records in an OTLP logs body, or undefined when it isn't one. */
function countLogRecords(body: unknown): number | undefined {
  if (!isObject(body) || !Array.isArray(body.resourceLogs)) return undefined;
  const resourceLogs = objectsIn(body, "resourceLogs");
  if (resourceLogs === undefined) return undefined;

  let count = 0;
  for (const resourceLog of resourceLogs) {
    const scopeLogs = objectsIn(resourceLog, "scopeLogs");
    if (scopeLogs === undefined) return undefined;
    for (const scopeLog of scopeLogs) {
      const logRecords = objectsIn(scopeLog, "logRecords");
      if (logRecords === undefined) return undefined;
      count += logRecords.length;
    }
  }
  return count;
}

/** Collector statuses the browser can act on; others mean a misconfigured relay. */
function isForBrowser(status: number): boolean {
  return (
    (status >= 200 && status < 300) ||
    [400, 408, 413, 429].includes(status) ||
    status >= 500
  );
}

const app = express();

app.post(
  APP_ANALYTICS_PATH,
  // Raw bytes, so the Collector receives exactly what the browser sent.
  express.raw({ type: "application/json", limit: "64kb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).end();
      return;
    }

    let records: number | undefined;
    try {
      records = countLogRecords(JSON.parse(req.body.toString("utf8")));
    } catch {
      records = undefined;
    }
    if (records === undefined) {
      res.status(400).end();
      return;
    }
    if (records > MAX_RECORDS) {
      res.status(413).end();
      return;
    }

    const endpoint = resolveOtlpLogsEndpoint();
    if (endpoint === undefined) {
      // App telemetry is off: accept and discard, so the browser doesn't retry.
      res.status(204).end();
      return;
    }

    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: req.body,
        redirect: "manual",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      await upstream.body?.cancel();

      if (!isForBrowser(upstream.status)) {
        console.warn(`OTel Collector answered ${upstream.status}`);
        res.status(502).end();
        return;
      }
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter && [429, 503].includes(upstream.status)) {
        res.set("Retry-After", retryAfter);
      }
      res.status(upstream.status).end();
    } catch (error) {
      console.warn("OTel Collector unreachable", error);
      res.status(502).end();
    }
  },
);
```

Keep these properties in any relay:

- **Forward the bytes you received.** The Analytics UI reads the exact records the producer built. Don't add, rename, or re-encode attributes. Re-serializing a parsed body can change it, and it fails on deeply nested JSON.
- **Forward no incoming headers.** Cookies and access tokens must not reach the Collector.
- **Return the Collector's status, with its `Retry-After`.** The browser library retries `408`, `425`, `429`, `5xx`, and network failures once, honoring a `Retry-After` of up to 10 seconds, and gives up on other statuses. Answer `502` to statuses the browser can't fix, such as `3xx`, `401`, `403`, and `404`.
- **Answer `204` when there is no Collector.** Otherwise every batch fails and is retried.
- **Bound the work.** Limit the body size, the records per request, the upstream wait, and the forwards in flight.
- **Make failures visible.** A relay that fails quietly loses every record. Log Collector failures, rate-limited, and count outcomes.

The route can live at another same-origin path. Pass that path as `endpoint` when you initialize the library.

## Delivery behavior

The current browser library uses **best-effort delivery with bounded retries**. Events may be lost or duplicated; there is no at-least-once or exactly-once guarantee.

| Behavior | Current library value |
| --- | --- |
| Batch trigger | 25 events, or five seconds, whichever comes first |
| Queue capacity | 100 events, memory only |
| Request body cap | 48 KiB encoded |
| Request timeout | 10 seconds |
| Retry | Once for transient failures, preserving event IDs and content, after the server's `Retry-After` when it is at most 10 seconds |
| Page hide | One bounded keepalive request |

A different producer can use another delivery strategy. It must retain the contract's event identity and deduplication semantics.

The library never persists event payloads in cookies, local storage, session storage, or IndexedDB. Only opaque session metadata is kept in `sessionStorage`. Overflow, a hard navigation, or an exhausted retry can lose records.

A resolved `flush()` means the library finished its bounded drain attempt. It does not confirm persistence in `otel_logs` or immediate query availability.

## Sessions and sampling

For the browser library, a session belongs to one top-level browser context. Its random ID starts when the client starts, survives reloads through `sessionStorage`, and rotates after 30 minutes without application activity. Activity extends a session whether or not the session is sampled. It is not derived from identity or a request ID.

The Action, Page View, and Web Vital producers share one sampling decision per session:

```typescript
appAnalytics.init({ sampleRate: 0.1 });
```

Shared sampling keeps the selection consistent across those types. It does not guarantee a complete session history: unsupported browser measurements and delivery loss can still leave gaps.

Server-side exporters preserve the originating session rather than needing browser storage themselves. A session is not a person, so Sessions must not be presented as Users or Unique Visitors.

## How the UI reads the data

Usage and performance queries use this order:

```text
select supported schema and event types
    -> validate and filter by time, route, and event
    -> deduplicate by event_id
    -> select latest report per web_vital_sample_id where applicable
    -> aggregate counts and p75
```

Time buckets are UTC. A session enters usage metrics only when a valid Action, Page View, or Web Vital occurs in the selected interval. See [UI interpretation](./api-reference.md#ui-interpretation) for metric definitions.

## Compatibility

`schema_version` belongs to the data, not to a library release. Optional fields and new application Action names are additive. Changes to required field meaning, session semantics, deduplication, or sample reduction need version review.

## Future: trace correlation

A future extension connects a Page View to observed HTTP, application, and SQL operations. A slow query during a slow page view is a lead to investigate, not proof of causation. See [Future: Trace](./api-reference.md#3-future-trace).
