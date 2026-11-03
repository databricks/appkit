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
  win.fetch ??= async () => ({});
  // Its one module-only piece is Vite's import.meta.hot, absent outside a
  // dev server.
  new Function(
    appReadyModule([ORIGIN]).replaceAll("import.meta.hot", "undefined"),
  )();
  return postMessage;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
