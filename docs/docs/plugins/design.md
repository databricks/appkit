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

## Configuration

| Option | Type | Description |
| ------ | ---- | ----------- |
| `builderOrigin` | `string \| string[]` | Origin(s) of the app builder that embeds the app, for example `"https://builder.example.com"`. When `/design` runs inside that window, each send is also posted to it (see [Embedding in an app builder](#embedding-in-an-app-builder)). Must be a bare origin; `"*"` is rejected. |

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

Selecting only happens on `/design`; app pages are left untouched. Click **Select** in the canvas header, then click elements to add or remove them (Escape stops selecting). Each selected element gets a numbered outline that matches its row in the send panel. Add an optional note and click **Send to agent**.

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
| `GET` | `/api/design/screenshots/:name` | A saved screenshot image |

## Embedding in an app builder

When the app runs inside an app builder (in an iframe, or in a window it opened) and `builderOrigin` is set, each send is also posted to that window (`window.parent`, else `window.opener`) with `window.postMessage`. The message is targeted at exactly the configured origins, so the browser drops it if the window is on any other origin. The file and the routes above work the same either way.

```ts
import type { DesignSelectionMessage } from "@databricks/appkit-ui/react/design";

// In the app builder:
window.addEventListener("message", (event) => {
  if (event.origin !== "http://localhost:8000") return; // the app's dev server
  const message = event.data as DesignSelectionMessage;
  if (message?.type !== "appkit:design-selection" || message.version !== 1) return;
  // message.note, message.selections[i].source, .props, .screenshot, ...
});
```

```ts
interface DesignSelectionMessage {
  type: "appkit:design-selection";
  version: 1;
  id?: string;      // id in .appkit/design-selection.json
  url: string;      // page the elements were picked on
  note?: string;
  selections: Array<{
    component?: string;   // nearest React component
    stack?: string[];     // owning components, innermost first
    source?: string;      // "file:line:col"
    props?: Record<string, unknown>;
    tag: string;
    text?: string;
    screenshot?: string;    // JPEG data URL
    screenshotUrl?: string; // same image, GET from the dev server
  }>;
}
```

The screenshot is inline as a data URL. `screenshotUrl` points at `GET /api/design/screenshots/:name` on the app's dev server.
