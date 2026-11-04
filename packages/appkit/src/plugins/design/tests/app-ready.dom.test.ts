// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

import { appReadyModule } from "../vite-plugin";

// jsdom globals; this package compiles without the DOM typings.
const win = globalThis as any;
const ORIGIN = "https://builder.example.com";

// Runs the generated script in this page, as the app's index.html would, with
// a builder window as the parent.
function load(html: string) {
  win.document.body.innerHTML = html;
  const postMessage = vi.fn();
  Object.defineProperty(win, "parent", {
    configurable: true,
    value: { postMessage },
  });
  // The status endpoint, as the script reports to it.
  statusReports.length = 0;
  win.fetch = async (_url: string, init?: { body?: string }) => {
    if (init?.body) statusReports.push(JSON.parse(init.body));
    return {};
  };
  // Its one module-only piece is Vite's import.meta.hot: a stand-in whose
  // events the test can fire.
  hot.handlers = {};
  win.__testHot = {
    on: (event: string, fn: () => void) => (hot.handlers[event] = fn),
  };
  new Function(
    appReadyModule([ORIGIN]).replaceAll("import.meta.hot", "window.__testHot"),
  )();
  return postMessage;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusReports: Record<string, unknown>[] = [];
const hot: { handlers: Record<string, () => void> } = { handlers: {} };

afterEach(() => {
  delete win.__appkitDesign;
});

test("posts appkit:app-ready for / in a hidden frame, where no animation frame runs", async () => {
  win.history.replaceState(null, "", "/");
  win.requestAnimationFrame = vi.fn(); // a hidden frame: never called back
  const postMessage = load('<div id="root"><h1>Tetris</h1></div>');

  await wait(700); // the 300 ms quiet window, then the 100 ms paint fallback
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith(
    { type: "appkit:app-ready", version: 1, path: "/" },
    ORIGIN,
  );
});

test("says nothing while the template home is up, then posts once the real page shows", async () => {
  win.history.replaceState(null, "", "/");
  win.requestAnimationFrame = vi.fn();
  const postMessage = load(
    '<div id="root"><main data-appkit-template-home>Welcome</main></div>',
  );
  await wait(700);
  expect(postMessage).not.toHaveBeenCalled();

  // The agent's finished page replaces it (here via client-side navigation).
  win.document.getElementById("root").innerHTML = "<h1>Tetris</h1>";
  win.history.pushState(null, "", "/play");
  await wait(700);
  expect(postMessage).toHaveBeenCalledWith(
    { type: "appkit:app-ready", version: 1, path: "/play" },
    ORIGIN,
  );
});

// Not a dashboard: a to-do form app, in a hidden preview (no animation frames).
test("a form app reports rendered and its runtime errors to the status endpoint, hidden", async () => {
  win.history.replaceState(null, "", "/");
  win.requestAnimationFrame = vi.fn();
  load(
    '<div id="root"><form><input name="todo"><button>Add</button></form><ul></ul></div>',
  );
  await wait(700);
  // (Earlier tests' copies of the script are still live on this window and
  // add reports of their own: check for these, not the exact list.)
  expect(statusReports[0]).toEqual({ app: "/", reset: true });
  expect(statusReports).toContainEqual({ app: "/", ok: true, template: false });
  const before = statusReports.length;

  // A click handler that throws: not a render error, still reported.
  win.dispatchEvent(
    new win.ErrorEvent("error", {
      error: new Error("Cannot read properties of undefined (reading 'title')"),
      message: "Cannot read properties of undefined (reading 'title')",
    }),
  );
  win.dispatchEvent(
    Object.assign(new win.Event("unhandledrejection"), {
      reason: new Error("save failed"),
    }),
  );
  await wait(10);
  const errors = statusReports.slice(before).filter((r) => "error" in r);
  expect(errors).toContainEqual({
    app: "/",
    error: "Cannot read properties of undefined (reading 'title')",
  });
  expect(errors).toContainEqual({
    app: "/",
    error: "Unhandled rejection: save failed",
  });
});

test("a crash that leaves nothing mounted is reported as not rendered, and no ready signal", async () => {
  win.history.replaceState(null, "", "/tools/convert");
  win.requestAnimationFrame = vi.fn();
  const postMessage = load('<div id="root"></div>');
  await wait(700);
  expect(statusReports).toContainEqual({
    app: "/tools/convert",
    ok: false,
    template: false,
  });
  expect(statusReports).not.toContainEqual(
    expect.objectContaining({ app: "/tools/convert", ok: true }),
  );
  expect(postMessage).not.toHaveBeenCalled();
});

// Not a dashboard: a quiz game whose answer handler threw, then got fixed by a
// hot update (no page load).
test("a hot update drops the errors from before it, then reports the page again", async () => {
  win.history.replaceState(null, "", "/quiz");
  win.requestAnimationFrame = vi.fn();
  load('<div id="root"><h1>Quiz</h1><button>Answer</button></div>');
  await wait(700);
  win.dispatchEvent(
    new win.ErrorEvent("error", {
      error: new Error("answers is undefined"),
      message: "answers is undefined",
    }),
  );
  await wait(10);
  expect(statusReports).toContainEqual({
    app: "/quiz",
    error: "answers is undefined",
  });
  const before = statusReports.length;

  hot.handlers["vite:afterUpdate"]();
  await wait(700);
  const after = statusReports.slice(before);
  expect(after[0]).toEqual({ app: "/quiz", reset: true });
  expect(after).toContainEqual({ app: "/quiz", ok: true, template: false });
  expect(after).not.toContainEqual(
    expect.objectContaining({ error: expect.anything() }),
  );
});
