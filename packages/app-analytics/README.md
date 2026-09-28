# @databricks/app-analytics

A browser library that implements the App Analytics data contract for Databricks
Apps. The package collects Actions, Page Views, and Web Vitals, encodes them as
OTLP/HTTP JSON, and sends them to a configurable same-origin endpoint.

> **Status:** under active development. The package is not published to npm
> yet; AppKit apps get it through `@databricks/appkit-ui`.

[App Analytics](../../docs/docs/app-analytics/getting-started.md) defines the
product, and its [data specification](../../docs/docs/app-analytics/api-reference.md)
defines the records interpreted by the Analytics UI. The `@databricks/app-analytics` package is one
implementation, not the specification. Other producers can emit the same
conforming data through the OTel Collector to the Unity Catalog `otel_logs` table.

See the product [architecture](../../docs/docs/app-analytics/architecture.md) and
[event guide](../../docs/docs/app-analytics/events.md) for the producer-independent
contract. This README documents the currently implemented library API.

## Endpoint

Browsers cannot reach the Databricks Apps OTel Collector, which listens only on
`localhost` inside the app. The package therefore posts to a same-origin route,
`/_analytics/v1/logs` by default, and the app's backend relays each request to
the collector. The AppKit `server()` plugin provides this route. Apps built
without AppKit must add their own relay at that path, or pass a different
same-origin `endpoint`:

```ts
appAnalytics.init({ endpoint: "/custom/logs" });
```

Cross-origin endpoints and endpoints with URL credentials fall back to the
default.

## Self-starting build

The build also emits `dist/browser/sdk.js`, a single minified ES module with
`web-vitals` bundled in. Loading it starts the default client with the options
in `window.__appkit__.appAnalytics`, unless the app has already called
`appAnalytics.init()`. The AppKit `server()` plugin ships this file, serves it
at `/_analytics/v1/sdk.js`, and adds it to every page when App telemetry is on.
It isn't a package export.

## Track Actions

```ts
import { appAnalytics } from "@databricks/app-analytics";

appAnalytics.init();

appAnalytics.track("order_exported", {
  format: "csv",
  rows: 1240,
});
```

Action names and property keys follow your naming convention:
`report_exported`, `reportExported`, and `Report Exported` are all accepted.
A name or key has 1 to 128 characters, no control characters, and no leading
or trailing whitespace. The SDK does not rename anything, so choose one
convention and use it consistently: `Report Exported` and `report_exported`
are different Actions.

Use low-cardinality names that describe a reusable event kind. Put details in
properties:

```ts
appAnalytics.track("report_exported", { format: "csv" });
```

Do not create names such as `report_exported_csv` or include IDs, credentials,
email addresses, or free text.

Properties are strings of up to 1,024 characters, finite numbers, or booleans,
at most 50 per event. Nullish values are omitted. The SDK also omits keys that
look like credentials or personal data, in any casing style: keys containing
the words `email`, `password`, `secret`, `token`, `authorization`, `cookie`,
`ip`, or `username` (`userEmail`, `auth_token`, and `Client IP` are omitted),
and keys in the `user.`, `enduser.`, `session.`, `url.`, `event.`, `browser.`,
`telemetry.`, and `databricks.` namespaces. This is a guard rail, not a privacy
boundary: it checks keys, never values.

Input that is not accepted is dropped and reported through `onDiagnostic` as
`invalid_event_name` or `property_dropped`. Calls made before `init()` are kept,
up to 100, and sent once it runs.

## Track annotated interactions

Annotated interaction tracking is on by default and observes only interactive
elements that the application explicitly names. Nothing is captured until an
element carries an annotation:

```html
<button data-app-analytics-event="export_clicked">Export</button>

<form data-app-analytics-event="search_submitted">
  <!-- form fields -->
</form>
```

The annotation value becomes an Action name. The package does not read text
content, form values, arbitrary attributes, CSS classes, or DOM hierarchy. Add
`data-app-analytics-ignore` to exclude a subtree.

Synthetic events, disabled controls, and unannotated elements are ignored. An
annotation on a non-interactive element (clicks) or on an element other than a
form (submits) cannot fire; it is reported once per element as an
`autocapture_ignored` diagnostic. At most 100 annotated interactions are
collected per analytics session. Pass `autocapture: false` to turn it off.

## Track Page Views

`init()` records the initial Page View and observes History API navigation
through `pushState`, `replaceState`, and `popstate`.

```ts
window.history.pushState({}, "", "/orders/42");
```

Page Views use:

```text
event_type = "page_view"
event_name = "page_view"
```

The package records only the page path. URL credentials, query strings, and
fragments are not included.

Use `page()` for an explicit Page View or custom properties:

```ts
appAnalytics.page({ section: "orders" });
```

Disable automatic tracking when a router integration records Page Views
explicitly:

```ts
appAnalytics.init({
  automaticPageViews: false,
});
```

## Collect Web Vitals

Web Vitals are off by default because they add about five records per page
load. Enable them during initialization:

```ts
appAnalytics.init({
  webVitals: true,
});
```

The package collects LCP, INP, CLS, FCP, and TTFB. The metric name becomes the
canonical event name:

```text
event_type = "web_vital"
event_name = "lcp"
```

Each report includes:

- value;
- unit, `ms` or `score`;
- delta from the previous report;
- sample ID;
- rating derived from the v1 thresholds;
- normalized navigation type when supported by v1.

CLS and INP may report more than once with the same sample ID. Consumers must
keep the latest report for each sample ID before calculating percentiles.

Web Vitals describe document navigation. A client-side route change can produce
a Page View without producing a new Web Vital sample.

## App Analytics fields in `otel_logs`

The package uses the `@databricks/app-analytics` instrumentation scope. The App
Analytics v1 fields are encoded as OTLP attributes:

| Logical field | OTLP attribute |
| --- | --- |
| `schema_version` | `databricks.app.analytics.schema.version` |
| `event_id` | `databricks.app.analytics.event.id` |
| `event_type` | `databricks.app.analytics.event.type` |
| `event_name` | `databricks.app.analytics.event.name` |
| `session_id` | `databricks.app.analytics.session.id` |
| `page_path` | `databricks.app.analytics.page.path` |
| `properties.<key>` | `databricks.app.analytics.properties.<key>` |
| `web_vital_value` | `databricks.app.analytics.web_vital.value` |
| `web_vital_unit` | `databricks.app.analytics.web_vital.unit` |
| `web_vital_delta` | `databricks.app.analytics.web_vital.delta` |
| `web_vital_sample_id` | `databricks.app.analytics.web_vital.sample_id` |
| `web_vital_rating` | `databricks.app.analytics.web_vital.rating` |
| `web_vital_navigation_type` | `databricks.app.analytics.web_vital.navigation_type` |

The OTLP LogRecord event name mirrors the canonical `event_name`.

Actions, Page Views, and Web Vitals also set `severityText: "INFO"`,
`severityNumber: 9`, and a JSON string in `body.stringValue` for generic log
viewers. The body projects only the logical fields already present in the
attributes, including application properties or typed Web Vital fields. It
never serializes raw event/context objects. Missing optional fields are omitted;
timestamps remain in the standard OTLP time fields. The browser SDK does not
set `app.instance_id`.

Analytics queries continue to use the typed attributes. Historical v1 records
without severity or body remain valid; these additions do not change the schema
version or require a query migration.

Example filter:

```sql
WHERE attributes['databricks.app.analytics.schema.version']::INT = 1
  AND attributes['databricks.app.analytics.event.type']::STRING = 'web_vital'
```

Use `databricks.app.analytics.event.id` to deduplicate retries. Use
`databricks.app.analytics.web_vital.sample_id` for Web Vital sample reduction.

## Sessions and sampling

`session_id` is a random correlation identifier backed by `sessionStorage`. It:

- is shared by clients running in the same browser context;
- survives reloads through `sessionStorage`;
- rotates after 30 minutes without an analytics event;
- does not identify a user.

Sampling is decided once per session, when the session starts, and shared by
Actions, Page Views, and Web Vitals. Activity extends a session whether or not
it is sampled, so sampling never shortens a session:

```ts
appAnalytics.init({
  sampleRate: 0.1,
});
```

The queue itself remains memory-only. Events are not written to cookies, local
storage, session storage, or IndexedDB.

## Delivery

Events are sent in batches of up to 25 records or after five seconds, whichever
comes first. The queue holds at most 100 events and an encoded request is limited
to 48 KiB, including the readable body and severity fields. Duplicating fields
in the body can reduce batch capacity; individually oversized events are dropped
with an `event_too_large` diagnostic, not truncated.

Delivery is best effort: records can be lost or duplicated. Transient failures
are retried once with the same event IDs, after the server's `Retry-After` when
it sends one (a delay over 10 seconds gives up the retry). Page-hide delivery
uses one bounded keepalive request. Network, encoding, and lifecycle failures do not throw into
application code. A resolved `flush()` does not confirm persistence in
`otel_logs`.

Use `flush()` for deterministic tests and lifecycle integrations:

```ts
await appAnalytics.flush();
```

Use `beforeSend` to discard or rewrite an event before it enters the queue.
Return `false` to drop it, nothing to keep it, or a copy with a changed `name`
(Actions only), `properties`, or `context.path`. Returned values are validated
like application input, and an invalid name or path drops the event:

```ts
appAnalytics.init({
  beforeSend: (event) => {
    if (event.name === "local_preview_opened") return false;
    // Group /orders/42 and /orders/43 as /orders/:id.
    return {
      ...event,
      context: {
        ...event.context,
        path: event.context.path.replace(/\/\d+/g, "/:id"),
      },
    };
  },
});
```

`onDiagnostic` receives sanitized metadata about dropped input, delivery
outcomes, and contained SDK failures (`internal_error`). Diagnostics never
contain event names, properties, URLs, endpoints, headers, or error messages.

## Configuration

`init()` merges options into the current configuration: an omitted option keeps
its current value, so a second `init()` changes only what it passes. Defaults
apply on the first `init()` and after `shutdown()`. `shutdown()` delivers queued
events, removes browser observers, and drops later events until the next
`init()`.

## Multiple clients

`appAnalytics` is the tab-wide default client. Importing the package creates
nothing: the client is built on first use and registered on `globalThis`, so
every copy of the package loaded in the tab (for example the one bundled into
`@databricks/appkit-ui` and one installed directly) configures and records
through the same client.

Create a separate client when a test or isolated runtime needs its own endpoint
and lifecycle:

```ts
import { createAppAnalytics } from "@databricks/app-analytics";

const analytics = createAppAnalytics();
analytics.init({ endpoint: "/custom-analytics" });
```

Clients in the same browser tab share the App Analytics session ID.

## React

```tsx
import { AppAnalytics } from "@databricks/app-analytics/react";

export function App() {
  return <AppAnalytics webVitals />;
}
```

Mount the component once at the application root. Props merge like `init()`
options, so an omitted prop does not undo configuration made elsewhere.
`beforeSend` and `onDiagnostic` can be inline functions. Set
`automaticPageViews={false}` when Page Views are managed explicitly.

## Privacy

The package has no identity API and does not add browser identity to events. It
does not include URL credentials, query strings, fragments, text content, form
values, raw DOM data, or raw browser performance entries.

Values passed to `track()` and `page()` are application data. Applications must
not pass credentials, tokens, email addresses, usernames, or other personal
data. Path segments are preserved; when a path can contain a sensitive or
high-cardinality value, rewrite `context.path` in `beforeSend`.
