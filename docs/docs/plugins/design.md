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
| `builderOrigin` | `string \| string[]` | Origin(s) of the app builder that embeds the app. The [design](#readiness) and [app](#app-readiness) ready messages are posted only to these origins, and `/design/__status` answers CORS for them. Must be a bare origin like `"https://builder.example.com"`; `"*"` is rejected. Defaults to the `APPKIT_DESIGN_BUILDER_ORIGIN` environment variable (one origin, or several separated by commas), so a builder's runtime can set it for a scaffolded `design()` with no options; an explicit `builderOrigin` wins. Optional: without either, no message is posted, and `/design/__status` still works. |

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

A builder that embeds `/design` can wait until there is a real design to show, instead of revealing an empty page. `/design` is **ready** once `client/src/design/index.tsx` exists, isn't the template placeholder, and has rendered in a browser since it last changed. **`ready` needs a browser, but not a visible one**: a client has to load `/design`, and a hidden iframe is enough (nothing waits for a painted frame, and nothing looks at pixels). To wait without a browser at all, use `compiled` and `waitingFor` (below). A page that throws while rendering (in the page file or any component it uses) shows the error in place, reports it, and turns `ready` back to `false` until a render succeeds again.

### What "ready" waits for

After a successful render the page waits until it shows its real content before reporting:

- web fonts have loaded (`document.fonts.ready`);
- no `Suspense` fallback is on screen (lazy components and data that suspend);
- no `fetch` started by the page is still in flight (its data, whatever kind);
- the page's DOM hasn't changed for 300 ms (lists filling in, content appearing);
- then two animation frames, or 100 ms without any: a hidden page (a builder's preview kept out of sight) gets no animation frames, and still reports.

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
  "compiled": true,
  "pages": [
    { "name": "index", "path": "/design", "compiled": true, "rendered": true, "errors": [], "state": "ready" },
    { "name": "orders", "path": "/design/orders", "compiled": true, "rendered": true, "errors": [{ "error": "Unhandled rejection: save failed" }], "state": "failed" }
  ],
  "app": { "entry": "/src/main.tsx", "compiled": true, "path": "/", "rendered": true, "template": false, "errors": [] }
}
```

`pages` lists every design page, index first, so a builder can show a page switcher. For each, as a browser (hidden is fine) last reported it for the file's current version:

- `rendered`: React mounted the page without a render error and it settled (see above).
- `errors`: what the page hit: its render error (caught by the page's error boundary), uncaught errors (event handlers, timers), unhandled promise rejections and Vite compile errors, each `{ "error": message }`. `null` until a browser has loaded this version of the page (unknown, not "no errors"). Errors are cleared when the page loads again or takes a hot update (also one to a component it imports): what's still wrong is reported again, so a fixed error disappears without a reload.

`app` is the same for the app's own pages (not `/design`):

- `entry`: the app's entry module, from `client/index.html`.
- `compiled`: that module and everything it imports build, checked server-side like `compiled` below (`compileError` when they don't).
- `path`: the page last reported. Each path is tracked on its own, so two tabs on different pages don't reset each other; `rendered`, `template` and `errors` are this path's.
- `rendered`: something is mounted in `#root` and the page settled (a crash outside an error boundary leaves `#root` empty: `false`, and its error is listed).
- `template`: it's the template's default home page.
- `errors`: as for `pages` (`null` until a page has loaded since the dev server started).

The status also carries:

| Field | Meaning |
| ----- | ------- |
| `compiled` | The index page and every module of the app it imports, transitively, build (compiled server-side as a browser would load them, so no browser is needed; dependencies in `node_modules` aren't recompiled). |
| `compileError` | Why it doesn't, prefixed with the failing module (`src/design/Card.tsx: ...`). |
| `waitingFor` | What `ready` is waiting on: `"index"` (no `index.tsx`), `"placeholder"` (still the template page), `"compile"` (build error), `"paint"` (no browser has rendered it yet, visible or not; the name is kept for compatibility), or `null` when ready. |
| `placeholder` | `index.tsx` is still the template placeholder. |

An agent writing the page waits for `compiled: true`; a builder that wants to reveal it loads `/design` (hidden is fine) and waits for `ready` or the `appkit:design-ready` message. To check that a page works, an agent reads `rendered` and `errors` here, for any kind of app (a game, a form, a chat, a dashboard); it never needs the preview to be visible, a resize, or a look at its pixels:

```ts
const s = await (await fetch(`${appUrl}/design/__status`)).json();
const appWorks = s.app.compiled && s.app.rendered && s.app.errors?.length === 0;
const pagesWork = s.pages.every((p) => p.rendered && p.errors?.length === 0);
```

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

The same idea for the real app, so a builder never reveals the template's default home page. In development the plugin adds a small script to the app's own pages (not `/design`). It always reports to `/design/__status` (`app`, above); with `builderOrigin` set it also posts to the builder. Once a page has settled (the same waits as [design readiness](#what-ready-waits-for), including `useDesignReady`), and again after client-side navigation and hot updates, it posts:

```ts
interface AppReadyMessage {
  type: "appkit:app-ready";
  version: 1;
  path: string; // location.pathname of the page that is ready
}
```

This is the signal for an app that skips `/design` (e.g. one that needs no data): the builder can load the app's `/` in a hidden frame and reveal it when `appkit:app-ready` arrives. It isn't posted while nothing is mounted in `#root` (a crash), and it's sent from a hidden frame too (the final wait for a paint gives up after 100 ms, as on `/design`).

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

## TSX drafts

TSX drafts are design pages written with real appkit-ui components. The plugin only renders them; whatever writes them (an app builder) owns the prompt, the model calls, the mock data and the type-check. A builder writes:

- `client/src/design/mock.ts`: the sample data the drafts share (any module works; the pages import it as `../mock`).
- `client/src/design/pages/<name>.tsx` per draft, default-exporting the page, served at `/design/<name>`. Write a page there only once it type-checks (e.g. write elsewhere, then move it in), so a half-written file never shows. Use theme tokens (`bg-background`, `text-foreground`, ...), so drafts work in dark mode.
- After moving a page in, touch `client/src/index.css` (update its modification time). Tailwind's Vite plugin only rescans sources for classes when the stylesheet changes, so until then a new page renders without its Tailwind styles.

Each page renders in its own error boundary and posts `appkit:design-ready` once rendered. Its state is in `GET /design/__status` under `pages` (see above): `compiled` / `compileError` (built server-side, no browser needed), `rendered`, `errors`, and `state`: `compile-error`, `rendering` (builds, not rendered yet), `ready` or `failed` (a browser reported errors).

### Streaming a draft while it's written

A builder can show a draft while it's still being written, instead of only once it's finished:

- Append the page's source, as it arrives, to `client/src/design/.staging/<name>.tsx` (and the shared mock's to `.staging/mock.ts`).
- Show `/design/__stream/<name>`. The dev server keeps the latest renderable version of the staging file under the page's real module (`pages/<name>.tsx`): it closes whatever is still open at the cut (JSX tags, brackets, template literals) and stubs what the page uses that hasn't arrived yet. Components not written yet show a `DraftPlaceholder` skeleton of the right shape. Each version reaches the page as a hot update, so it fills in in place, with no reload and with its state kept.
- Until `mock.ts` exists, the page's `../mock` import is what `.staging/mock.ts` has so far, plus stubs for whatever the page imports from it that isn't there yet.
- When the page type-checks, write it to `pages/<name>.tsx` (and `mock.ts`): the same module then loads from disk. Deleting the staging file starts that draft over.

Every design page, streamed or not, renders through `DesignPage` (from `@databricks/appkit-ui/react/beta`; the plugin adds it, pages don't). It applies the app's theme before the first paint (`?theme=dark` or `?theme=light` on the URL, else the system setting), so a dark page never flashes light. If a render fails mid-stream, it keeps the last good frame on screen instead of a broken page, and holds readiness back until a render succeeds.

Lock-in is a file operation for the builder: keep the chosen page as `client/src/design/index.tsx` (`/design`, repointing `../mock` to `./mock`), or as the app's home page for apps with no data, and delete the other drafts.
