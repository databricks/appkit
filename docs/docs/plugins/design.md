---
sidebar_position: 20
---

# Design plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

Dev-only design pages, for building a layout before it becomes part of the real app. The plugin only runs with `NODE_ENV=development`. In any other environment it does nothing, and `/design` returns 404.

## Basic usage

```ts
import { createApp, server } from "@databricks/appkit";
import { design } from "@databricks/appkit/beta";

await createApp({
  plugins: [server(), design({ builderOrigin: "https://builder.example.com" })],
});
```

## Configuration

| Option | Type | Description |
| ------ | ---- | ----------- |
| `builderOrigin` | `string \| string[]` | Origin(s) of the app builder that embeds the app. The [design](#readiness) and [app](#app-readiness) ready messages and [draft errors](#draft-errors) are posted only to these origins. Must be a bare origin like `"https://builder.example.com"`; `"*"` is rejected. Optional: without it no message is posted, and `/design/__status` still works. |

## Pages

| URL | File |
| --- | ---- |
| `/design` | `client/src/design/index.tsx` |
| `/design/<name>` | `client/src/design/pages/<name>.tsx` |

Each file's default export is the page, rendered on its own at full size with the app's styles (`client/src/index.css`). Anything else under `/design` returns 404. The page names `index` and anything starting with `__` are reserved (`pages/index.tsx` would collide with `/design`, and `__status` is the plugin's own endpoint), so such files aren't served or listed. Pages hot-reload like the rest of the app. The requested page is loaded directly and other pages only when navigated to, so an unfinished draft only breaks its own URL.

When the app has `react-router` (the app template does), design pages share a router whose basename is `/design`. Links between them stay inside `/design`, and keep working when the pages are later promoted into the app's own routes:

```tsx
import { Link } from "react-router";

<Link to="/orders">Orders</Link>; // goes to /design/orders
```

Without `react-router`, each page renders on its own; link with `<a href="/design/orders">`.

```tsx
// client/src/design/index.tsx
import { Button, Card, CardContent, CardHeader, CardTitle } from "@databricks/appkit-ui/react";

export default function DesignPage() {
  return (
    <Card className="m-10 max-w-sm">
      <CardHeader>
        <CardTitle>Orders</CardTitle>
      </CardHeader>
      <CardContent>
        <Button>New order</Button>
      </CardContent>
    </Card>
  );
}
```

## Mapping elements to source

In development, the dev server adds `data-source="file:line:col"` to every native JSX element, on design pages and app pages alike. A builder's element inspector can use it to map what was clicked back to the code that renders it.

## Readiness

A builder that embeds `/design` can wait until there is a real design to show, instead of revealing an empty page. `/design` is **ready** once `client/src/design/index.tsx` exists, isn't the template placeholder, and has painted in a browser since it last changed. **`ready` needs a browser**: nothing turns it true until a client loads `/design` and paints it (a hidden iframe is enough). To wait without a browser, use `compiled` and `waitingFor` (below). A page that throws while rendering (in the page file or any component it uses) shows the error in place and turns `ready` back to `false` until a render succeeds again.

### What "ready" waits for

After a successful render the page waits until it shows its real content before reporting:

- web fonts have loaded (`document.fonts.ready`);
- no `Suspense` fallback is on screen (lazy components and data that suspend);
- no `fetch` started by the page is still in flight, for example chart data;
- the page's DOM hasn't changed for 300 ms (charts drawing, lists filling in);
- then two animation frames, so it has painted.

It never reports while the page is the template placeholder or is showing a render error. The automatic waits give up after 10 seconds, so a stream that never ends can't hold the page back forever.

### Holding readiness back: `useDesignReady`

For content the page can't detect on its own (a chart that draws on a timer, an animation, data from a source that isn't `fetch`), hold readiness back explicitly. While any mounted component passes `false`, the page isn't ready, with no time limit:

```tsx
import { useDesignReady } from "@databricks/appkit-ui/react/beta";

function TripsPerDay() {
  const { data, loading } = useAnalyticsQuery("trips_per_day", {});
  useDesignReady(!loading && data != null);
  return <LineChart data={data ?? []} />;
}
```

It also holds back [app readiness](#app-readiness) on the app's own pages in development. Elsewhere (production, tests) it does nothing, so it can stay in components that are later promoted into the app.

### Placeholder

The app template's starter page is marked as a placeholder by this export. Delete it when you write the real page:

```tsx
export const designPlaceholder = true;
```

### `GET /design/__status`

```json
{
  "ready": true,
  "pages": [
    { "name": "index", "path": "/design" },
    { "name": "orders", "path": "/design/orders" }
  ]
}
```

`pages` lists every design page, index first, so a builder can show a page switcher. The status also carries:

| Field | Meaning |
| ----- | ------- |
| `compiled` | The index page and every module of the app it imports, transitively, build (compiled server-side as a browser would load them, so no browser is needed; dependencies in `node_modules` aren't recompiled). |
| `compileError` | Why it doesn't, prefixed with the failing module (`src/design/Card.tsx: ...`). |
| `waitingFor` | What `ready` is waiting on: `"index"` (no `index.tsx`), `"placeholder"` (still the template page), `"compile"` (build error), `"paint"` (no browser has painted it yet), or `null` when ready. |
| `placeholder` | `index.tsx` is still the template placeholder. |
| `drafts`, `blockSchema`, `theme` | See [HTML drafts](#html-drafts). |

An agent writing the page waits for `compiled: true`; a builder that wants to reveal it loads `/design` (hidden is fine) and waits for `ready` or the `appkit:design-ready` message.

### `appkit:design-ready` message

Once a design page is ready (see above) and again after each hot update that leaves it ready, the page posts this to `window.parent` (or `window.opener`), only to the configured `builderOrigin`s:

```ts
interface DesignReadyMessage {
  type: "appkit:design-ready";
  version: 1;
  page: string; // name of the page that painted ("index" or <name>)
  pages: { name: string; path: string }[];
}
```

```ts
// In the app builder:
window.addEventListener("message", (event) => {
  if (event.origin !== appOrigin) return;
  if (event.data?.type === "appkit:design-ready" && event.data.version === 1) {
    showDesign(event.data.pages);
  }
});
```

## App readiness

The same idea for the real app, so a builder never reveals the template's default home page. In development, when `builderOrigin` is set, the plugin adds a small script to the app's own pages (not `/design`). Once a page has settled (the same waits as [design readiness](#what-ready-waits-for), including `useDesignReady`), and again after client-side navigation and hot updates, it posts:

```ts
interface AppReadyMessage {
  type: "appkit:app-ready";
  version: 1;
  path: string; // location.pathname of the page that is ready
}
```

It isn't posted while an element with the `data-appkit-template-home` attribute is on screen. The app template's default home page (`HomePage` in `client/src/App.tsx`) carries it; a builder can also look for it directly. Remove the attribute, or the page, when the app gets its real home page, and the next settle (a hot update counts) posts `appkit:app-ready`.

```ts
// In the app builder:
window.addEventListener("message", (event) => {
  if (event.origin !== appOrigin) return;
  if (event.data?.type === "appkit:app-ready" && event.data.version === 1) {
    showApp(event.data.path);
  }
});
```

## HTML drafts

Quick layout drafts are plain HTML files in the app's `drafts/` folder, served in development at `/design/drafts/<name>` (`drafts/dashboard.html` → `/design/drafts/dashboard`). A missing draft returns 404.

Drafts share the app template's theme by linking `/design/drafts/theme.css` instead of inlining tokens: appkit-ui's CSS variables (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--chart-1` … ) for light, and for dark via `prefers-color-scheme`, plus the page background and text color at zero specificity, so the draft's own styles win:

```html
<link rel="stylesheet" href="/design/drafts/theme.css" />
```

A draft is streamed while it's still being written: the plugin sends what the file holds and keeps appending what's added, until the file ends with `</html>` (or stops changing for 8 seconds). So a draft fills in on screen as the agent writes it. Editing a finished draft reloads it.

### `data-appkit` blocks

Costly parts of a draft (charts, tables, KPI cards) are written as JSON blocks instead of hand-built HTML. The plugin injects one script into every draft that renders each block with the real appkit-ui component as soon as its JSON is complete, even while the rest of the file is still streaming. It uses no CDN and no network, and theme colors follow the app's styles and the system light/dark preference. Each block renders in its own shadow root, so the draft's own CSS and the components' styles don't affect each other.

```html
<script type="application/json" data-appkit="BarChart">
  {"title": "Trips per day", "x": ["Mon", "Tue", "Wed"], "series": [{"name": "Trips", "data": [12, 19, 7]}]}
</script>
```

The exact props of each component are published as JSON Schema (2020-12), with an example per component, in the package as `@databricks/appkit-ui/design/components.schema.json` (`node_modules/@databricks/appkit-ui/dist/design/components.schema.json`), and served at `GET /design/__data-appkit.schema.json` (linked from `/design/__status` as `blockSchema`). Read it to write valid blocks. In short:

| Component | Required | Optional |
| --------- | -------- | -------- |
| `BarChart` | either `x` (non-empty array of labels) and `series` (non-empty array of `{ name: string, data: (number \| null)[] }`, one value per label), or `data` (array of row objects) | `xKey`, `yKey` (with `data`), `title`, `height`, `showLegend`, `colors`, `ariaLabel`, `orientation` (`"vertical"` \| `"horizontal"`), `stacked` |
| `LineChart` | same as `BarChart` | as `BarChart` without `stacked`, plus `smooth`, `showSymbol` |
| `AreaChart` | same as `BarChart` | as `LineChart`, plus `stacked` |
| `PieChart`, `DonutChart` | same as `BarChart`; one series, `x` are the slice names | `title`, `height`, `showLegend`, `colors`, `ariaLabel`, `innerRadius` (0-100), `showLabels`, `labelPosition` (`"outside"` \| `"inside"` \| `"center"`) |
| `DataTable` | `columns`: non-empty array of column names or `{ key: string, label?: string }`; `rows`: array of objects keyed by column key, or arrays in column order | |
| `KpiCard` | `label`: string; `value`: string or number | `delta` (string or number), `hint` (string) |

`DataTable` renders with appkit-ui's `Table` primitives (the `DataTable` component itself loads its rows through a query), and `KpiCard` with appkit-ui's `Card` parts. Charts take their colors from the app's theme tokens, which follow the system light/dark preference, also in a draft with a dark background.

Turning a draft into a `/design` page is then mostly mechanical: the component and its props are already there.

### Draft errors

A block that can't render (unknown component, props that don't fit, or JSON still invalid once the file is complete) shows a small "Couldn't render" placeholder in the draft, and the error goes back to the agent two ways:

- `GET /design/__status` lists every draft with the errors of its current version (each new load of the draft replaces them):

  ```json
  {
    "drafts": [
      {
        "name": "dashboard",
        "path": "/design/drafts/dashboard",
        "errors": [{ "block": 3, "component": "LineChart", "error": "invalid JSON: ..." }]
      }
    ]
  }
  ```

- each error is posted to the embedding builder (only to `builderOrigin`):

  ```ts
  interface DraftErrorMessage {
    type: "appkit:draft-error";
    version: 1;
    draft: string;     // draft name
    block: number;     // index of the block among the draft's data-appkit blocks
    component: string; // the data-appkit value
    error: string;
  }
  ```
