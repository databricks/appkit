---
title: Using App Analytics with AppKit
sidebar_label: Using with AppKit
sidebar_position: 2
description: AppKit starts App Analytics in every page when App telemetry is on, and the server plugin relays the records to the OTel Collector. Mount it from @databricks/appkit-ui to change its options, or turn it off.
---

# Using App Analytics with AppKit

An AppKit app gets both halves of App Analytics from AppKit:

- The `server()` plugin exposes `POST /_analytics/v1/logs`, the library's default endpoint, and relays each batch to the Databricks Apps OTel Collector.
- When App telemetry is on, the `server()` plugin also starts the library in every page it serves. Page Views are recorded with no client code.
- `@databricks/appkit-ui` carries the browser library and re-exports it from its beta entry points, for Actions and for options that only the browser can set.

There is nothing to add on the server and no `endpoint` to configure.

:::info[Not the Analytics plugin]

App Analytics is browser usage and experience telemetry. The [Analytics plugin](../plugins/analytics.md) runs SQL queries against a SQL Warehouse. The two are unrelated.

:::

## Automatic start

When App telemetry is on, the server plugin adds a script tag to every `index.html` it serves, in development and in production:

```html
<script type="module" src="/_analytics/v1/sdk.js"></script>
```

The server plugin serves `/_analytics/v1/sdk.js` itself. It is a self-contained, minified build of the library, `web-vitals` included, that ships inside `@databricks/appkit`. On load, it starts the tab's shared `appAnalytics` client, which records the initial page and every History API navigation.

Set the options of the started library on the server:

```ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server({
      appAnalytics: { webVitals: true, autocapture: true, sampleRate: 0.5 },
    }),
  ],
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `webVitals` | `false` | Records LCP, INP, CLS, FCP, and TTFB. |
| `autocapture` | `false` | Records clicks and submits on elements annotated with `data-app-analytics-event`. |
| `sampleRate` | `1` | Fraction of browser sessions to collect, from 0 to 1. |

The options reach the page as `window.__appkit__.appAnalytics`. `beforeSend` and `onDiagnostic` are functions, so only browser code can set them, with `<AppAnalytics />` or `appAnalytics.init()`.

Without App telemetry, for example in `pnpm dev` without `OTEL_EXPORTER_OTLP_ENDPOINT`, the server adds no script tag, and the page sends nothing on its own.

:::note[Upgrading]

Apps with App telemetry enabled start recording Page Views once they upgrade to an AppKit version with automatic start. To keep the previous behavior, pass `appAnalytics: false`, which also removes the relay. See [Turn App Analytics off](#turn-app-analytics-off).

:::

## Configure the library in the browser

Mounting the library is optional in an AppKit app. Mount it to set `beforeSend` or `onDiagnostic`, to change options per page, or to keep recording when you turn the automatic start off.

```tsx
import { AppAnalytics } from "@databricks/appkit-ui/react/beta";

export function RootLayout() {
  return (
    <>
      <AppAnalytics webVitals autocapture />
      <Outlet />
    </>
  );
}
```

Mount `<AppAnalytics />` once, near the root of the app. It renders nothing. It configures the tab's shared `appAnalytics` client and doesn't shut the client down when it unmounts.

| Prop | Default | Effect |
| --- | --- | --- |
| `automaticPageViews` | `true` | Records the initial page and every History API navigation. |
| `webVitals` | `false` | Records LCP, INP, CLS, FCP, and TTFB. |
| `autocapture` | `false` | Records clicks and submits on elements annotated with `data-app-analytics-event`. |
| `sampleRate` | `1` | Fraction of browser sessions to collect, from 0 to 1. |
| `beforeSend` | none | Return `false` to discard an event before it enters the queue. |
| `onDiagnostic` | none | Receives sanitized delivery diagnostics that never include event content. |
| `endpoint` | `/_analytics/v1/logs` | Same-origin path the library posts to. Leave it unset in AppKit apps. |

The component re-initializes the client whenever a prop changes, so pass `beforeSend` and `onDiagnostic` with a stable identity, such as a module-level function or a `useCallback` result.

The automatically started build and `<AppAnalytics />` configure the same client, so a tab still records one Page View per navigation. The app's options win in either order. If the app configures the client before the build loads, the build leaves the client alone. If the app configures it afterwards, its options replace the ones set on the server. The app's options replace the server's as a whole, so pass every option you want, for example `webVitals` again.

## Track Actions

```tsx
import { appAnalytics } from "@databricks/appkit-ui/react/beta";

appAnalytics.track("report_exported", { format: "csv", rows: 1240 });
appAnalytics.page({ section: "reports" });
```

Actions need the client to be started, either automatically or by the app. Before that, `track()` and `page()` record nothing.

Outside React, import from `@databricks/appkit-ui/js/beta`. It exports `appAnalytics`, `createAppAnalytics`, and the option, event, and diagnostic types:

```typescript
import { appAnalytics } from "@databricks/appkit-ui/js/beta";

appAnalytics.init({ webVitals: true, autocapture: true });
appAnalytics.track("report_exported", { format: "csv" });
```

`appAnalytics` is one client per browser tab. The `react/beta` and `js/beta` exports, the automatically started build, and any other copy of the library loaded in the tab all configure and record through that same client. Importing either entry point creates nothing until the client is first used, so apps that don't use App Analytics don't pay for it in their bundle.

See [Events](./events.md) for naming rules, annotated autocapture, and what each type records.

## The server side

```ts
import { createApp, server } from "@databricks/appkit";

await createApp({
  plugins: [server()],
});
```

The server plugin answers `POST /_analytics/v1/logs` as follows. Every response has an empty body.

| Situation | Response |
| --- | --- |
| The body is over 64 KiB | `413` |
| The body isn't `application/json` | `415` |
| The body isn't valid JSON, or its `resourceLogs` isn't an array | `400` |
| App telemetry is off | `204`. The records are discarded, and the server logs one warning. |
| App telemetry is on | Forwards the JSON body unchanged to the Collector and answers with the Collector's status. |
| The Collector can't be reached or doesn't answer within 5 seconds | `502`. The server logs one warning on the first failure. |

The browser library never sends more than 48 KiB per request, so the 64 KiB limit only stops other clients. The relay parses its own requests, so the server's `bodyLimit` doesn't apply to it.

The relay resolves the Collector endpoint the way the OTLP exporters do. It uses `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` as-is, and otherwise appends `/v1/logs` to `OTEL_EXPORTER_OTLP_ENDPOINT`. It forwards none of the incoming request headers and doesn't follow redirects. The relay checks only the outer shape of the payload. The Collector decides what to accept, and the relay passes its answer back. For example, the Databricks Apps Collector answers `400` to `{"resourceLogs":[]}`, a batch the browser library never sends.

Answering `204` when telemetry is off keeps local development quiet: the browser library neither retries nor reports a failure.

`GET /_analytics/v1/sdk.js` answers with the browser build as `text/javascript`. Its URL carries no version, so browsers revalidate it on every page load and pick up a new build right after an upgrade.

The relay carries only App Analytics records. AppKit creates no spans, wide-event logs, or request metrics for incoming requests under `/_analytics/`. Apart from the two one-time warnings above, the relay logs nothing.

### Turn App Analytics off

Pass `appAnalytics: false` to remove the relay, the `sdk.js` route, and the script tag:

```ts
await createApp({
  plugins: [server({ appAnalytics: false })],
});
```

To serve App Analytics from another path, or to add your own checks, turn the built-in relay off and mount your own route with `server.extend()`. The [reference relay](./architecture.md#reference-relay-for-apps-built-without-appkit) is a starting point. Nothing starts the library for you then, so mount it and pass the route's path as `endpoint`:

```ts
// server
await createApp({
  plugins: [server({ appAnalytics: false })],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.post("/telemetry/browser-logs", myAppAnalyticsRelay);
    });
  },
});
```

```tsx
// client
<AppAnalytics endpoint="/telemetry/browser-logs" webVitals autocapture />
```

A route mounted this way is an ordinary server route. The server's JSON parser and its `bodyLimit` apply to it, and AppKit's telemetry records it like any other request.

## Turn on App telemetry

Databricks Apps sets `OTEL_EXPORTER_OTLP_ENDPOINT` only when App telemetry (Beta) is enabled for the app. To enable it, open the app's **Settings**, choose **App telemetry configuration**, pick a Unity Catalog catalog and schema, then save and redeploy the app. App Analytics records then land in the app's `otel_logs` table, next to AppKit's own logs.

To see records locally, point `OTEL_EXPORTER_OTLP_ENDPOINT` at a local OpenTelemetry Collector that accepts OTLP/HTTP JSON, for example `http://localhost:4318`. The server reads it at startup to decide whether to add the script tag.

## Try it in the dev playground

The dev playground mounts `<AppAnalytics webVitals autocapture />` in `apps/dev-playground/client/src/routes/__root.tsx`. Its **App Analytics** page (`/app-analytics`) tracks an Action, records a Page View, queues a burst of 30 events, flushes the queue, and lists any diagnostics. Run `pnpm dev`, open the page with DevTools, and watch `POST /_analytics/v1/logs` answer `204`.

Run `pnpm dev` with `OTEL_EXPORTER_OTLP_ENDPOINT` set to see the automatic start as well: the page source has the `sdk.js` script tag, and each navigation still records one Page View.

## Stability

App Analytics ships from the beta entry points of `@databricks/appkit-ui`, so its API can change between minor releases. `@databricks/appkit-ui` carries the library inline, and the only runtime dependency it adds is `web-vitals`. `@databricks/appkit` carries the automatically started build as a file and adds no dependency.
