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
| `builderOrigin` | `string \| string[]` | Origin(s) of the app builder that embeds the app. The [ready message](#readiness) is posted only to these origins. Must be a bare origin like `"https://builder.example.com"`; `"*"` is rejected. Optional: without it no message is posted, and `/design/__status` still works. |

## Pages

| URL | File |
| --- | ---- |
| `/design` | `client/src/design/index.tsx` |
| `/design/<name>` | `client/src/design/pages/<name>.tsx` |

Each file's default export is the page, rendered on its own at full size with the app's styles (`client/src/index.css`). Anything else under `/design` returns 404. Pages hot-reload like the rest of the app. The requested page is loaded directly and other pages only when navigated to, so an unfinished draft only breaks its own URL.

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

A builder that embeds `/design` can wait until there is a real design to show, instead of revealing an empty page. `/design` is **ready** once `client/src/design/index.tsx` exists, isn't the template placeholder, and has painted in a browser since it last changed.

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

`pages` lists every design page, index first, so a builder can show a page switcher.

### `appkit:design-ready` message

After a design page first paints (and after each hot update), unless it's the placeholder, the page posts this to `window.parent` (or `window.opener`), only to the configured `builderOrigin`s:

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
