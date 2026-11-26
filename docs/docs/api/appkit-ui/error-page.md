---
sidebar_position: 8
---

# Error page

When a route throws, React Router shows its own built-in error page: a "Hey developer" note while developing, and the error's message and stack in a deployed app. AppKit apps show their own error page instead. It says that something went wrong (for a 404, that the page was not found) and offers **Reload** and **Back to home**; Back to home is the primary action on a 404, where a reload would only repeat the miss. The error's message and stack show only in development (`import.meta.env.DEV`), never in a production build.

It covers both kinds of route errors: an error thrown while rendering a route (or from a loader or action), and a route error response such as a 404 (`isRouteErrorResponse`).

## In the app template

The template's `client/src/App.tsx` sets a `RouteErrorPage` as the `errorElement` of its root layout route, so every page gets it:

```tsx
const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/", element: <HomePage /> },
      // ...
    ],
  },
]);
```

`RouteErrorPage` is defined in the same file: edit it to change what your app shows.

## `ErrorPage` in your own router

`ErrorPage` from `@databricks/appkit-ui/react` is the same page as a component. Pass it the route's error, and your router's link as `homeLink`, so Back to home navigates inside the app (keeping its state) and under the router's `basename`:

```tsx
import { ErrorPage } from "@databricks/appkit-ui/react";
import { Link, useRouteError } from "react-router";

function RouteErrorPage() {
  return (
    <ErrorPage
      error={useRouteError()}
      homeLink={<Link to="/">Back to home</Link>}
    />
  );
}

const router = createBrowserRouter([
  { element: <Layout />, errorElement: <RouteErrorPage />, children: [/* ... */] },
]);
```

Without `homeLink`, Back to home is `<a href="/">`, a full page load of the app's root. `ErrorPage` doesn't depend on a router. With TanStack Router, for example: `errorComponent: ({ error }) => <ErrorPage error={error} homeLink={<Link to="/">Back to home</Link>} />`.

## Replacing it

React Router renders the nearest `errorElement` (or `ErrorBoundary`) above the route that failed, so a route's own one wins over the default:

```tsx
{ path: "/orders", element: <OrdersPage />, errorElement: <OrdersError /> }
```

To replace the page for the whole app, set a different `errorElement` on the root route.
