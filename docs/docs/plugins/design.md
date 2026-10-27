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
  plugins: [server(), design()],
});
```

## Pages

| URL | File |
| --- | ---- |
| `/design` | `client/src/design/index.tsx` |
| `/design/<name>` | `client/src/design/pages/<name>.tsx` |

Each file's default export is the page, rendered on its own at full size with the app's styles (`client/src/index.css`). A design route whose file doesn't exist returns 404. Pages hot-reload like the rest of the app.

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
