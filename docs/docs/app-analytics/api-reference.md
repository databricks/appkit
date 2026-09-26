---
title: App Analytics data specification
sidebar_label: Data specification
sidebar_position: 5
description: The App Analytics data contract, including OTLP encoding, validation, privacy, and UI semantics.
---

# App Analytics data specification

**Status:** Proposal · **Version:** 1

App Analytics is defined by the data that reaches the OTel Collector, not by any client library. Any producer that emits rows satisfying this specification is a valid producer. A backend can forward events from an app interaction, and a batch job can replay captured events while preserving their original context. A producer's runtime does not change the meaning of a field or remove its requirements.

`@databricks/app-analytics` is a browser library that implements the contract. It is not the specification and is not required for conformance. See [Producing the data](./getting-started.md) for integration choices.

:::note[What conformance means]

The Analytics UI reads rows, not API calls. If your rows satisfy the schema, encoding, and validation rules below, the UI works. If they do not, the rows are excluded from queries no matter which tool wrote them.

:::

## 1. What it is

Databricks App Analytics defines the event schema used to measure product usage and user experience in Databricks Apps.

The specification covers three data types:

| Data type | `event_type` | Purpose |
| --- | --- | --- |
| Action | `action` | Records a product action such as exporting a report or applying a filter. |
| Page View | `page_view` | Records a visit to an application route. |
| Web Vitals | `web_vital` | Records a browser performance sample. |

### MVP architecture

```text
App Analytics Data Spec
    -> OTel Collector
    -> Unity Catalog otel_logs
    -> Analytics UI
```

In the MVP, App Analytics data is stored in the Unity Catalog `otel_logs` table. The Analytics UI reads and interprets these records according to the schema below.

App Analytics supports product analytics and performance analysis. It is not a security or transaction audit log.

## 2. Spec

### Requirement levels

- **Required:** the field must contain a valid value. Otherwise, the row is excluded from App Analytics queries.
- **Conditionally required:** the field is required when its stated condition is true. Otherwise, it must be null.
- **Optional:** the field may be null.

Fields defined for one event type must be null for all other event types. A row that violates this rule is excluded from App Analytics queries.

### Common event schema

Each matching `otel_logs` row represents one logical App Analytics event.

| Field            | Type             | Requirement | Description                                    |
| ---------------- | ---------------- | ----------- | ---------------------------------------------- |
| `schema_version` | `INT`            | Required    | Major schema version. The v1 value is `1`.     |
| `event_id`       | `STRING`         | Required    | Opaque event identifier.                       |
| `event_type`     | `STRING`         | Required    | `action`, `page_view`, or `web_vital`.         |
| `event_name`     | `STRING`         | Required    | Low-cardinality name within the event type.    |
| `occurred_at`    | `TIMESTAMP`      | Required    | Time when the event occurred.                  |
| `session_id`     | `STRING`         | Required    | Opaque analytics session identifier.           |
| `page_path`      | `STRING`         | Optional    | Sanitized concrete path, such as `/orders/42`. |
| `properties`     | `VARIANT` object | Optional    | Application-defined scalar properties.         |

### MVP encoding in `otel_logs`

The MVP stores the logical fields in the existing `otel_logs` columns and attributes below. It does not create another table, view, or canonical dataset.

| Logical field               | `otel_logs` source                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `occurred_at`               | `time`                                                                                            |
| `schema_version`            | `attributes["databricks.app.analytics.schema.version"]`                                           |
| `event_id`                  | `attributes["databricks.app.analytics.event.id"]`                                                 |
| `event_type`                | `attributes["databricks.app.analytics.event.type"]`                                               |
| `event_name`                | `attributes["databricks.app.analytics.event.name"]`                                               |
| `session_id`                | `attributes["databricks.app.analytics.session.id"]`                                               |
| `page_path`                 | `attributes["databricks.app.analytics.page.path"]`                                                |
| `properties`                | Attributes beginning with `databricks.app.analytics.properties.`; the suffix is the property key. |
| `web_vital_value`           | `attributes["databricks.app.analytics.web_vital.value"]`                                          |
| `web_vital_unit`            | `attributes["databricks.app.analytics.web_vital.unit"]`                                           |
| `web_vital_delta`           | `attributes["databricks.app.analytics.web_vital.delta"]`                                          |
| `web_vital_sample_id`       | `attributes["databricks.app.analytics.web_vital.sample_id"]`                                      |
| `web_vital_rating`          | `attributes["databricks.app.analytics.web_vital.rating"]`                                         |
| `web_vital_navigation_type` | `attributes["databricks.app.analytics.web_vital.navigation_type"]`                                |

A v1 consumer selects rows with `schema_version=1` and a supported `event_type`. The official browser producer uses `instrumentation_scope.name="@databricks/app-analytics"`. That scope resembles the product name, but the resemblance is incidental: it identifies only that one producer and does not define schema compatibility. A conforming producer may use any scope, so filtering on this value excludes valid rows written by other producers. The `date` column may be used for partition pruning and does not add a logical field to the Data Spec.

Identifiers must be globally unique:

| Concept          | Identifier            |
| ---------------- | --------------------- |
| Event            | `event_id`            |
| Session          | `session_id`          |
| Web Vital sample | `web_vital_sample_id` |

#### Wire format

A producer sends these attributes as an OTLP log record. This is a complete structural example for one Action, with illustrative IDs and a historical timestamp. Generate fresh IDs and use the actual event time for a new event; replaying an existing event preserves its original ID and content. No particular library is required:

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
                  "key": "databricks.app.analytics.page.path",
                  "value": { "stringValue": "/reports" }
                },
                {
                  "key": "databricks.app.analytics.properties.format",
                  "value": { "stringValue": "csv" }
                },
                {
                  "key": "databricks.app.analytics.properties.rows",
                  "value": { "intValue": "1240" }
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

Notes for anyone hand-building this payload:

- `timeUnixNano` becomes `occurred_at`. It is a **string** of Unix nanoseconds.
- OTLP integers are JSON **strings** (`"intValue": "1"`), while doubles are numbers (`"doubleValue": 1.25`). `web_vital_value` and `web_vital_delta` are always doubles.
- `scope.name` is free-form: it records which producer wrote the row and has no effect on validity.
- The record's `eventName` mirrors `event_name`.
- Absent fields are omitted from OTLP attributes and read as null in the logical schema.

#### Query the landed rows

```sql
SELECT
  time AS occurred_at,
  attributes['databricks.app.analytics.event.type']::STRING AS event_type,
  attributes['databricks.app.analytics.event.name']::STRING AS event_name,
  attributes['databricks.app.analytics.page.path']::STRING  AS page_path
FROM otel_logs
WHERE attributes['databricks.app.analytics.schema.version']::INT = 1
  AND attributes['databricks.app.analytics.event.type']::STRING
      IN ('action', 'page_view', 'web_vital')
  AND date >= current_date() - INTERVAL 7 DAYS
ORDER BY occurred_at DESC;
```

This is an ingestion diagnostic, not the full validation and deduplication query used by the UI. A row appearing here does not by itself establish conformance.

### Event names

`event_type` identifies the event family. `event_name` identifies the specific event within that family.

| `event_type` | `event_name`                                                           |
| ------------ | ---------------------------------------------------------------------- |
| `action`     | Application-defined name such as `order_exported` or `filter_applied`. |
| `page_view`  | `page_view`                                                            |
| `web_vital`  | `lcp`, `inp`, `cls`, `fcp`, or `ttfb`.                                 |

### Event properties

`properties` is an object with application-defined keys and scalar values.

Property keys follow the same lowercase dot-and-underscore grammar as Action names. They must not use reserved analytics, identity, session, telemetry, URL, or user namespaces. Keys containing sensitive segments such as `email`, `password`, `secret`, `token`, `authorization`, `cookie`, `username`, or `ip` are rejected.

Allowed value types:

- string;
- finite number;
- boolean.

The following values are not allowed:

- arrays;
- nested objects;
- null values;
- credentials, tokens, or secrets;
- email addresses, usernames, or other personal data.

Limits:

| Limit                | Value |
| -------------------- | ----: |
| Properties per event |    50 |
| Property key length  |   128 |
| String value length  | 1,024 |

A property that violates its type, key, or size constraint is omitted. A property identified as containing prohibited data is removed. If prohibited data appears in a required field, the row is excluded from App Analytics queries.

### Action

An Action records a named product fact.

Action names:

- contain between 1 and 128 characters;
- use lowercase letters, numbers, dots, and underscores;
- begin with a letter;
- do not contain consecutive delimiters;
- do not use reserved analytics, identity, session, telemetry, URL, or user namespaces;
- describe a reusable event kind rather than one occurrence;
- do not contain IDs, email addresses, or free text.

Example:

```text
event_type = "action"
event_name = "report_exported"
properties = { "format": "csv", "rows": 1240 }
```

Use properties for details. For example, use `report_exported` with `format="csv"` instead of `report_exported_csv`.

### Page View

A Page View records a visit to an application route.

Required values:

```text
event_type = "page_view"
event_name = "page_view"
```

`page_path`:

- begins with `/`;
- excludes credentials, query strings, and fragments;
- contains the concrete application path.

Applications must not place credentials, tokens, personal data, or free text in URL paths. A path that violates the syntactic rules is omitted. A Page View remains valid without page context, but it is excluded from route-level aggregations.

### Session

`session_id` identifies one analytics session in a top-level browser context.

A session:

- begins when the first event is recorded;
- remains stable across client-side navigation and reloads;
- expires after 30 minutes without a recorded analytics event;
- is not derived from a user identifier, email address, IP address, request identifier, or access token.

The browser library persists this metadata in `sessionStorage`; that storage API is an implementation choice, not a requirement for a server that forwards the event. A backend producer must preserve a valid session from the originating app interaction. A backfill preserves the original session and event time.

A standalone job with no originating session does not fit the v1 common envelope. Omitting `session_id` invalidates the entire row, not just session-scoped metrics. Do not invent a session from a job ID, request ID, or user identity. Supporting unassociated server events requires a separately defined contract change.

`session_id` is correlation metadata. It does not identify a person.

The UI may display the metric name "Sessions." It must not interpret Sessions as Users or Unique Visitors.

### Web Vital

A Web Vital records one report for a browser performance sample.

Web Vital rows use the following columns:

| Column                      | Type     | Requirement            | Description                                                                            |
| --------------------------- | -------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `web_vital_value`           | `DOUBLE` | Required for Web Vital | Cumulative metric value.                                                               |
| `web_vital_unit`            | `STRING` | Required for Web Vital | Unit determined by `event_name`.                                                       |
| `web_vital_delta`           | `DOUBLE` | Required for Web Vital | Change since the previous report for the sample.                                       |
| `web_vital_sample_id`       | `STRING` | Required for Web Vital | Identifier shared by reports for one sample.                                           |
| `web_vital_rating`          | `STRING` | Required for Web Vital | Rating derived from `event_name` and `web_vital_value`.                                |
| `web_vital_navigation_type` | `STRING` | Optional               | `navigate`, `reload`, `back_forward`, `back_forward_cache`, `prerender`, or `restore`. |

`web_vital_value` and `web_vital_delta` must be finite and greater than or equal to zero.

#### Units and thresholds

| `event_name` | Measures                | Unit    |       Good |      Poor |
| ------------ | ----------------------- | ------- | ---------: | --------: |
| `lcp`        | Loading performance     | `ms`    | `<= 2,500` | `> 4,000` |
| `inp`        | Responsiveness          | `ms`    |   `<= 200` |   `> 500` |
| `cls`        | Visual stability        | `score` |   `<= 0.1` |  `> 0.25` |
| `fcp`        | First content render    | `ms`    | `<= 1,800` | `> 3,000` |
| `ttfb`       | Initial server response | `ms`    |   `<= 800` | `> 1,800` |

`web_vital_unit` is derived from this table. A row with a different unit is invalid.

`web_vital_rating` is derived as follows:

- `good` when the value is at or below the Good threshold;
- `needs_improvement` when the value is above Good and at or below Poor;
- `poor` when the value is above the Poor threshold.

#### Sample reduction

A Web Vital sample may produce multiple reports. Web Vital queries keep one row per `web_vital_sample_id`.

The selected report is the row with:

1. the greatest `occurred_at`;
2. the greatest `event_id` as a deterministic tie-breaker when event times are equal.

Percentiles are calculated only after sample reduction.

Web Vitals describe a document navigation. A client-side route change can produce a Page View without producing a new Web Vital sample.

### Event deduplication

App Analytics queries count one row per `event_id`.

Rows with the same `event_id` must contain identical App Analytics values. Identical duplicates are counted once.

If the same `event_id` is reused for different event content, every row in the collision set is excluded from App Analytics queries and reported as a data-quality error.

Web Vital sample reduction happens after event deduplication:

```text
deduplicate by event_id
    -> select latest report by web_vital_sample_id
    -> calculate percentiles
```

### Trusted context and privacy

V1 does not include authoritative user identity.

App Analytics records must not contain:

- user email or username;
- IP address;
- access tokens or authorization headers;
- cookies;
- URL credentials, query strings, or fragments;
- element text or input values;
- raw DOM data;
- raw browser performance entries.

The Live Events detail view uses an explicit column and property allowlist. It does not display an unrestricted source record.

### UI interpretation

Usage and performance calculations use the `otel_logs` source configured for the selected App and apply these filters before aggregation:

- `event_type` is `action`, `page_view`, or `web_vital`;
- `occurred_at >= start_time` and `occurred_at < end_time`;
- page path or event filters when selected.

Time buckets use UTC. A Session is included when at least one event with its `session_id` falls within the selected interval.

| UI value              | Definition                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- |
| Page Views            | Distinct `event_id` count where `event_type="page_view"`.                             |
| Sessions              | Distinct `session_id` among Action, Page View, and Web Vital rows.                    |
| Tracked Actions       | Distinct `event_id` count where `event_type="action"`.                                |
| Pages per Session     | Page Views divided by Sessions. No value is shown when Sessions is zero.              |
| Top Actions           | Actions grouped by `event_name`.                                                      |
| Top Routes            | Page Views grouped by `page_path`. Rows without `page_path` are excluded.             |
| Web Vital p75         | Nearest-rank p75 of `web_vital_value` after event deduplication and sample reduction. |
| Web Vital sample size | Distinct `web_vital_sample_id` count.                                                 |
| Latest event          | Greatest `occurred_at` among usage and performance rows.                              |
| Live Events           | Most recent valid usage and performance rows, ordered by `occurred_at` and `event_id`. |

For an ordered set of `N` Web Vital values, nearest-rank p75 is the value at position `ceil(0.75 * N)` using one-based indexing.

A Web Vital group with fewer than 30 samples displays "Low sample." The measured value may be shown, but trend comparisons must not be presented as conclusive.

The UI must not derive Unique Visitors, user retention, bounce rate, referrers, geography, device, or browser dimensions unless a later schema version defines the required data and semantics.

### Compatibility

`schema_version` identifies the major App Analytics schema version.

Consumers ignore unsupported event types rather than treating them as Actions.

The following changes are backward compatible within v1:

- adding an optional column;
- adding a new application-defined Action name.

The following changes require a new major schema version:

- removing a required column;
- changing a required column's type or meaning;
- changing identifier scope, session semantics, deduplication, or Web Vital sample reduction;
- changing the meaning of an event type or reserved event name;
- adding a new event type without defining its columns, validation, privacy, and UI behavior.

## 3. Future: Trace

Trace correlation will connect an application event to the operations performed while handling it.

The proposed trace dataset includes:

| Field                 | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `operation_id`        | Identifies one operation.                                  |
| `trace_id`            | Groups related operations.                                 |
| `parent_operation_id` | Identifies the parent operation when known.                |
| `page_view_event_id`  | References the `event_id` of the associated Page View.     |
| `operation_type`      | Classifies browser, HTTP, application, or SQL work.        |
| `operation_name`      | Low-cardinality operation name.                            |
| `started_at`          | Operation start time.                                      |
| `ended_at`            | Operation end time.                                        |
| `status`              | Operation result.                                          |
| `statement_id`        | Links a SQL operation to its query profile when available. |

`page_view_event_id` references the `event_id` of the Page View. It does not introduce a second identifier for the same Page View occurrence.

Operations may form parent-child relationships across browser, HTTP, application, and SQL work. No fixed hierarchy is defined by this proposal.

### UI interpretation

Trace data can support investigations such as:

1. identify a route with poor LCP p75;
2. select an affected Page View;
3. inspect operations associated with that Page View;
4. find slow application or SQL operations;
5. open a related SQL statement profile.

The UI must describe these relationships as correlation. A slow SQL operation observed during a slow Page View does not prove that the query caused the Web Vital result.

The UI must represent missing operation data explicitly. An unresolved reference may result from sampling, delivery delay, retention, or data loss.

### Open decisions

The trace extension must define:

- trace datasets and required fields;
- identifier scope and referential-integrity rules;
- event-to-operation association rules;
- operation naming and status rules;
- sampling and missing-operation semantics;
- retention and query requirements;
- UI navigation between events, operations, and SQL statement profiles.
