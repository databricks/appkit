---
sidebar_position: 20
---

# Design plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

A dev-only design canvas and element picker for working with a coding agent. It only runs with `NODE_ENV=development`. In any other environment it does nothing, and `/design` returns 404.

## Basic usage

```ts
import { createApp, server } from "@databricks/appkit";
import { design } from "@databricks/appkit/beta";

await createApp({
  plugins: [server(), design()],
});
```

## The `/design` canvas

`/design` renders every PascalCase export of every file under `client/src/design/`, with no props, one frame each. Put two kinds of components there:

- **Drafts**: design-only UI that may later be moved into the real app.
- **Previews**: wrappers that render the app's real components with mock data.

```tsx
// client/src/design/OrderCard.preview.tsx
import { OrderCard } from "../components/OrderCard";

export function OrderCardShipped() {
  return <OrderCard order={{ id: "42", status: "shipped", total: 99 }} />;
}
```

A frame that throws shows its error in place. It doesn't break the rest of the canvas.

## Selecting elements

In development, a **Select** button appears in the bottom-right corner of the canvas and of every app page. Click it, then click elements to add or remove them (Escape stops selecting). Add an optional note and click **Send to agent**.

Each element is traced back to its source `file:line:col`: the dev server tags native JSX elements with `data-source`, and the design plugin also tags component call sites (such as `<Button>` from a library) with `data-appkit-source`. The picker reads these, plus the nearest React component and its current props, from React's fiber tree. Screenshots include images, canvases, and CSS background images. Web fonts and cross-origin resources served without CORS are not embedded.

## Handing selections to the agent

Each send is appended to `.appkit/design-selection.json`, so selections survive restarts. Add `.appkit/` to `.gitignore`.

```json
{
  "selections": [
    {
      "id": "80b453fd-…",
      "ts": "2026-10-20T12:22:45.026Z",
      "note": "make the button primary",
      "url": "/design",
      "elements": [
        {
          "component": "Button",
          "stack": ["Button", "ProbeCard"],
          "source": "client/src/design/Probe.tsx:5:4",
          "props": { "variant": "secondary" },
          "tag": "button",
          "text": "Probe button",
          "screenshot": ".appkit/design-screenshots/80b453fd-…-0.jpeg"
        }
      ]
    }
  ]
}
```

Screenshots are saved as image files next to it, so an agent can open them directly. The agent can read the file itself, or use these routes:

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/design/selection` | Read all pending selections |
| `POST` | `/api/design/selection` | Add a selection (used by the picker) |
| `DELETE` | `/api/design/selection` | Clear selections and screenshots once applied |
