import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryRouter,
  Outlet,
  type RouteObject,
  RouterProvider,
  useRouteError,
} from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ErrorPage } from "../error-page";

// Wired like the app template's App.tsx: the default on the layout route.
function RouteErrorPage() {
  return <ErrorPage error={useRouteError()} />;
}

function Orders(): never {
  throw new Error("orders failed to render");
}

const pages: RouteObject[] = [
  { path: "/", element: <p>Home</p> },
  { path: "/orders", Component: Orders },
];

function renderApp(
  path: string,
  { children = pages, withDefault = true } = {},
) {
  const layout: RouteObject = { element: <Outlet />, children };
  if (withDefault) layout.errorElement = <RouteErrorPage />;
  render(
    <RouterProvider
      router={createMemoryRouter([layout], { initialEntries: [path] })}
    />,
  );
}

beforeEach(() => {
  // React and React Router log every caught route error.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ErrorPage as the default route error element", () => {
  test("without it, React Router shows its own default page", async () => {
    renderApp("/orders", { withDefault: false });
    expect(
      await screen.findByText("Unexpected Application Error!"),
    ).toBeTruthy();
    expect(screen.getByText(/Hey developer/)).toBeTruthy();
  });

  test("a route that throws renders the AppKit error page, not React Router's", async () => {
    renderApp("/orders");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(screen.queryByText(/Hey developer/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to home" }).getAttribute("href"),
    ).toBe("/");
  });

  test("a 404 route error response renders it as page not found", async () => {
    renderApp("/no-such-page");
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    // Development: the status and React Router's message.
    expect(screen.getByText(/404 Not Found/).textContent).toMatch(
      /No route matches URL "\/no-such-page"/,
    );
    expect(
      screen.getByRole("link", { name: "Back to home" }).getAttribute("href"),
    ).toBe("/");
  });

  test("shows the message and stack in development", async () => {
    renderApp("/orders");
    const details = (await screen.findByText(/orders failed to render/))
      .textContent;
    expect(details).toMatch(/at Orders/);
  });

  test("hides the message and stack outside development", async () => {
    vi.stubEnv("DEV", false);
    renderApp("/orders");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText(/orders failed to render/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  test("hides a 404's details outside development", async () => {
    vi.stubEnv("DEV", false);
    renderApp("/no-such-page");
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(screen.queryByText(/No route matches/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  test("an app's own errorElement wins over the default", async () => {
    renderApp("/orders", {
      children: [
        { path: "/orders", Component: Orders, errorElement: <p>Own error</p> },
      ],
    });
    expect(await screen.findByText("Own error")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});

describe("ErrorPage", () => {
  test("shows a thrown non-Error value in development", () => {
    render(<ErrorPage error="plain string" />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("plain string")).toBeTruthy();
  });
});
