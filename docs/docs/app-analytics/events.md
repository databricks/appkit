---
title: App Analytics events
sidebar_label: Events
sidebar_position: 4
description: Action, Page View, and Web Vitals events, with SDK examples, data projections, naming rules, and UI interpretation.
---

import Tabs from "@theme/Tabs";
import TabItem from "@theme/TabItem";

# App Analytics events

The specification describes three data types. `event_type` identifies the family, and `event_name` identifies the event within it. The browser library is one producer of the data, not the definition of those concepts.

| Data type | `event_type` | `event_name` | Observation source |
| --- | --- | --- | --- |
| Action | `action` | Application-defined, such as `order_exported` | An app interaction, emitted or forwarded by a conforming producer |
| Page View | `page_view` | `page_view` | A visit to an application route |
| Web Vitals | `web_vital` | `lcp`, `inp`, `cls`, `fcp`, `ttfb` | Real browser performance measurements |

The browser library implements all three types. Fields belonging to one family must be null on the others; mixing them invalidates the row.

Examples pair a library call with the data it produces. Another implementation that emits equivalent conforming records gets the same UI interpretation. All producers must preserve valid event IDs and originating session context.

## Action

An Action records a named product fact. The application chooses the fact and its name; the contract constrains its shape and meaning as a reusable event kind.

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

This represents one logical event. The IDs are illustrative; generate fresh event IDs for new facts and retain them for retries. See [Wire format](./api-reference.md#wire-format).

</TabItem>
</Tabs>

### Naming

Names follow the application's naming convention: `report_exported`, `reportExported`, and `Report Exported` are all valid. They contain 1 to 128 characters, with no control characters and no leading or trailing whitespace. Names are case-sensitive and never rewritten, so `Report Exported` and `report_exported` are different Actions: pick one convention and keep it.

A name describes a reusable event kind, not one occurrence:

| Instead of | Use |
| --- | --- |
| `report_exported_csv` | `report_exported` with `format="csv"` |
| `order_4821_shipped` | `order_shipped` with a suitable bounded property |
| `clicked_the_blue_export_button` | `export_clicked` for intent, or `report_exported` after success |

Names containing IDs, email addresses, or free text create unbounded cardinality and may disclose prohibited data. This rule applies to every producer, not just the browser library.

### Annotated autocapture

Autocapture is a browser library convenience, not a separate data type. Its rows are ordinary Actions. It is on by default and observes only interactive elements that the app explicitly names, so nothing is recorded until an element carries an annotation. Pass `autocapture: false` to turn it off.

```html
<button data-app-analytics-event="export_clicked">Export</button>

<form data-app-analytics-event="search_submitted">
  <!-- fields -->
</form>
```

The annotation becomes the Action name and follows the same rules. Add `data-app-analytics-ignore` to exclude a subtree. Synthetic events, disabled controls, and unannotated elements are ignored. An annotation that cannot fire, on a non-interactive element or a submit annotation outside a form, is reported once per element as an `autocapture_ignored` diagnostic. The library caps annotated interactions at 100 per analytics session.

A captured click is not proof that an operation succeeded. Emit an explicit completion Action after the work finishes if that is what the metric should count.

## Page View

A Page View records a visit to an application route.

<Tabs groupId="analytics-producer">
<TabItem value="sdk" label="Using the browser library" default>

`init()` records the initial view and observes History API navigation through `pushState`, `replaceState`, and `popstate`.

```typescript
appAnalytics.page({ section: "orders" });
```

Disable automatic tracking when a router integration owns the timing:

```typescript
appAnalytics.init({ automaticPageViews: false });
```

</TabItem>
<TabItem value="data" label="The data it sends">

```text
schema_version = 1
event_id       = "event-2"
event_type     = "page_view"
event_name     = "page_view"
session_id     = "session-1"
page_path      = "/orders/42"
properties     = { "section": "orders" }
occurred_at    = <event time>
```

Automatic navigation tracking is a library feature. A valid visit recorded by another producer has the same contract.

</TabItem>
</Tabs>

### Paths

`page_path` begins with `/` and contains the concrete path without credentials, query strings, or fragments. Path segments are preserved. Never put tokens, emails, or free text in a path.

A syntactically invalid path is omitted. The Page View still counts, but it is excluded from route-level aggregations such as Top Routes.

The contract records `/orders/42` and `/orders/43` as distinct concrete paths. Grouping them into `/orders/:id` is a query or UI concern, not a producer rewrite of `page_path`.

## Web Vital

A Web Vital records a report for a real browser performance sample. The App Analytics implementation uses the `web-vitals` library. A server may forward an actual captured measurement, but cannot substitute server timings for it.

<Tabs groupId="analytics-producer">
<TabItem value="sdk" label="Using the browser library" default>

```typescript
appAnalytics.init({ webVitals: true });
```

</TabItem>
<TabItem value="data" label="The data it sends">

```text
schema_version            = 1
event_id                  = "event-3"
event_type                = "web_vital"
event_name                = "lcp"
session_id                = "session-1"
page_path                 = "/dashboard"
web_vital_value           = 1840.0
web_vital_unit            = "ms"
web_vital_delta           = 1840.0
web_vital_sample_id       = "sample-1"
web_vital_rating          = "good"
web_vital_navigation_type = "navigate"
occurred_at               = <event time>
```

All `web_vital_*` fields except navigation type are required. They must be null on the other two families. Value and delta encode as OTLP doubles.

</TabItem>
</Tabs>

| `event_name` | Measures | Unit | Good | Poor |
| --- | --- | --- | ---: | ---: |
| `lcp` | Loading performance | `ms` | ≤ 2,500 | > 4,000 |
| `inp` | Responsiveness | `ms` | ≤ 200 | > 500 |
| `cls` | Visual stability | `score` | ≤ 0.1 | > 0.25 |
| `fcp` | First content render | `ms` | ≤ 1,800 | > 3,000 |
| `ttfb` | Initial server response | `ms` | ≤ 800 | > 1,800 |

The unit follows the metric. A different unit invalidates the row. Rating is `good` at or below the Good threshold, `poor` above the Poor threshold, and `needs_improvement` between them.

### One sample, several reports

CLS and INP can produce several reports for one `web_vital_sample_id`. After event deduplication, queries keep the report with the greatest `occurred_at`, breaking ties with the greatest `event_id`. Calculate percentiles only after that reduction.

Without sample reduction, one page load contributes several times to the distribution.

### Document navigation, not every route change

A client-side route change produces a Page View but does not start a new Web Vital sample. Page View and Web Vital sample counts need not match in a single-page app.

## Properties

Properties carry varying application details for an event. Keys follow the Action naming rules, in the application's convention, and cannot use reserved namespaces such as `user.` or `session.`. Keys containing a sensitive word such as `email`, `password`, `secret`, `token`, `authorization`, `cookie`, `username`, or `ip` are rejected in any casing style: `userEmail`, `auth_token`, and `Client IP` are all rejected. The check reads keys, never values. The browser library reports every omitted key as a `property_dropped` diagnostic.

<Tabs groupId="analytics-producer">
<TabItem value="sdk" label="Using the browser library" default>

```typescript
appAnalytics.track("filter_applied", {
  filter: "region",
  results: 128,
  saved: true,
});
```

</TabItem>
<TabItem value="data" label="The data it sends">

```text
databricks.app.analytics.properties.filter  = "region"  (string)
databricks.app.analytics.properties.results = "128"     (OTLP intValue)
databricks.app.analytics.properties.saved   = true      (bool)
```

Each scalar becomes an attribute under the property prefix. The string encoding of `intValue` does not turn the logical number into a string property.

</TabItem>
</Tabs>

Allowed values are strings, finite numbers, and booleans. Arrays, nested objects, and null values are not allowed. Neither are credentials, emails, usernames, or other personal data.

| Limit | Value |
| --- | ---: |
| Properties per event | 50 |
| Property key length | 128 characters |
| String value length | 1,024 characters |

The library omits invalid properties rather than throwing into application code. A prohibited value in a required field invalidates the row.

## Metrics each data type produces

| UI value | Derived from |
| --- | --- |
| Page Views | Distinct event IDs for Page View rows |
| Sessions | Distinct session IDs in Action, Page View, and Web Vital rows |
| Tracked Actions | Distinct event IDs for Action rows |
| Pages per Session | Page Views divided by Sessions |
| Top Actions | Actions grouped by event name |
| Top Routes | Page Views grouped by concrete path, excluding missing paths |
| Web Vital p75 | Nearest-rank p75 after event deduplication and sample reduction |

A Web Vital group with fewer than 30 samples is labeled Low sample; trends are not conclusive at that size.

V1 does not derive Unique Visitors, retention, bounce rate, referrers, geography, device, or browser dimensions. See [UI interpretation](./api-reference.md#ui-interpretation) for exact definitions.

## Choosing what to track

Start with questions that someone intends to answer:

1. Record Actions for outcomes such as `report_exported` or `case_saved`.
2. Record explicit failure facts such as `validation_failed` where useful.
3. Use Page Views to understand route visits.
4. Enable Web Vitals when browser performance matters to the workflow.

Event names are maintained and queried long after instrumentation is added. Choose a stable kind and put varying detail in its permitted fields.
