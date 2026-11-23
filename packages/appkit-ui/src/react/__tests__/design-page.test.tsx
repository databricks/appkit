import { act, cleanup, render, screen } from "@testing-library/react";
import * as react from "react";
import {
  type ComponentType,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import * as reactDomClient from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { streamHostModule } from "../../../../appkit/src/plugins/design/stream";
import { DesignPage, DraftPlaceholder } from "../design-page";

type Host = { blockers: number; changed?: () => void };
const win = window as { __appkitDesign?: Host };

const shell = () => document.querySelector("[data-design-page]") as HTMLElement;

const frame = () =>
  act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

function Page({ text }: { text: string }) {
  if (text === "boom") throw new Error("boom");
  return <h1>{text}</h1>;
}

afterEach(() => {
  cleanup();
  delete win.__appkitDesign;
  document.documentElement.classList.remove("dark");
  history.replaceState(null, "", "/");
});

describe("DesignPage", () => {
  test("keeps the last good frame on a render error, holds readiness, and retries", async () => {
    win.__appkitDesign = { blockers: 0 };
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <DesignPage onError={onError} resetKey={0}>
        <Page text="Trips" />
      </DesignPage>,
    );
    await frame();

    rerender(
      <DesignPage onError={onError} resetKey={0}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    // The copy of the last good frame, not an error.
    expect(screen.getByRole("heading").textContent).toBe("Trips");
    expect(document.querySelector("[data-design-last-good]")).not.toBeNull();
    expect(win.__appkitDesign.blockers).toBe(1);

    rerender(
      <DesignPage onError={onError} resetKey={1}>
        <Page text="Trips today" />
      </DesignPage>,
    );
    expect(screen.getByRole("heading").textContent).toBe("Trips today");
    expect(win.__appkitDesign.blockers).toBe(0);
  });

  test("an error before any good render shows its message in [data-design-error], until a retry renders", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <DesignPage resetKey={0}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
      "Design page failed to render: boom",
    );
    expect(shell().querySelector("[data-design-last-good]")).toBeNull();
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);

    rerender(
      <DesignPage resetKey={1}>
        <Page text="Trips" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")).toBeNull();
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
    expect(screen.getByRole("heading").textContent).toBe("Trips");
  });

  test("marks the shell rendered once the page commits, an empty page too, and not while an error replaces it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Marked in an effect after the commit, not yet in the page's layout effects.
    let markedEarly: boolean | undefined;
    function Empty() {
      useLayoutEffect(() => {
        markedEarly = shell().hasAttribute("data-design-rendered");
      }, []);
      return <div />;
    }
    const { rerender } = render(
      <DesignPage resetKey={0}>
        <Empty />
      </DesignPage>,
    );
    expect(markedEarly).toBe(false);
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
    await frame();

    rerender(
      <DesignPage resetKey={0}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-last-good]")).not.toBeNull();
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);

    rerender(
      <DesignPage resetKey={1}>
        <Page text="Trips" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-last-good]")).toBeNull();
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
  });

  test("an observer of the DOM sees one state at a time through error, rendered, last-good and back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Outside act(), so effects run when React schedules them, as in a browser.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const el = document.body.appendChild(document.createElement("div"));
    const root = reactDomClient.createRoot(el);
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const s = el.querySelector("[data-design-page]");
      if (!s) return;
      const state = [
        s.hasAttribute("data-design-rendered") && "rendered",
        s.querySelector("[data-design-last-good]") && "last-good",
        s.querySelector("[data-design-error]") && "error",
      ].filter(Boolean);
      seen.push(state.join("+") || "none");
    });
    observer.observe(el, { subtree: true, childList: true, attributes: true });
    const show = async (text: string, resetKey: number) => {
      root.render(
        <DesignPage resetKey={resetKey}>
          <Page text={text} />
        </DesignPage>,
      );
      await new Promise((r) => setTimeout(r, 50));
    };
    try {
      await show("boom", 0);
      await show("Trips", 1);
      await show("boom", 1);
      await show("Trips", 2);
    } finally {
      observer.disconnect();
      root.unmount();
      el.remove();
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(seen.filter((s) => s.includes("+"))).toEqual([]);
    expect(seen).toEqual(
      expect.arrayContaining(["error", "rendered", "last-good"]),
    );
    expect(seen.at(-1)).toBe("rendered");
  });

  test("a thrown non-Error still shows its reason", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Throws({ value }: { value: unknown }): never {
      throw value;
    }
    const { rerender } = render(
      <DesignPage resetKey={0}>
        <Throws value="draft import failed" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
      "Design page failed to render: draft import failed",
    );
    rerender(
      <DesignPage resetKey={1}>
        <Throws value={null} />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
      "Design page failed to render: null",
    );
  });

  test("errorFallback replaces the message, but rendering nothing still shows it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <DesignPage errorFallback={(e) => <p>Oops: {e.message}</p>}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
      "Oops: boom",
    );
    // Nothing to show (null, false, ""): the message, never an empty node.
    for (const [i, empty] of [null, false, ""].entries()) {
      rerender(
        <DesignPage errorFallback={() => empty} resetKey={i + 1}>
          <Page text="boom" />
        </DesignPage>,
      );
      expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
        "Design page failed to render: boom",
      );
    }
    // And a retry with a fallback that shows text uses it again.
    rerender(
      <DesignPage errorFallback={(e) => <p>Oops: {e.message}</p>} resetKey={9}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(shell().querySelector("[data-design-error]")?.textContent).toBe(
      "Oops: boom",
    );
  });

  test("a page that suspends isn't marked rendered while its fallback shows", async () => {
    // Suspends until open(); close() makes the next render suspend again.
    let done = false;
    let promise = Promise.resolve();
    let open = () => {};
    const close = () => {
      done = false;
      promise = new Promise<void>((r) => {
        open = () => {
          done = true;
          r();
        };
      });
    };
    function Slow({ text }: { text: string }) {
      if (!done) throw promise;
      return <h1>{text}</h1>;
    }
    const reveal = () =>
      act(async () => {
        open();
        await promise;
        // React may hold a reveal back a moment after a fallback.
        await new Promise((r) => setTimeout(r, 400));
      });
    const show = (text: string) => (
      <DesignPage pendingFallback={<p>Loading</p>}>
        <Slow text={text} />
      </DesignPage>
    );
    close();
    const { rerender } = render(show("Trips"));
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);
    await reveal();
    expect(screen.getByRole("heading").textContent).toBe("Trips");
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);

    // A later update that suspends hides the page: not rendered until it shows.
    close();
    rerender(show("Trips today"));
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);
    await reveal();
    expect(screen.getByRole("heading").textContent).toBe("Trips today");
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
  });

  test("only the page itself is kept as the last good frame, not a pending fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A hidden frame: no animation frames, so the copy can't wait for one.
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 0);
    try {
      let state = "wait";
      let open = () => {};
      const wait = new Promise<void>((r) => (open = r));
      function Draft() {
        if (state === "wait") throw wait;
        if (state === "boom") throw new Error("first draft failed");
        return <h1>Trips</h1>;
      }
      const show = (resetKey: number) => (
        <DesignPage pendingFallback={<p>Loading draft</p>} resetKey={resetKey}>
          <Draft />
        </DesignPage>
      );
      const { rerender } = render(show(0));
      // It suspended, then failed: never rendered, so the error shows.
      await act(async () => {
        state = "boom";
        open();
        await wait;
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(shell().querySelector("[data-design-last-good]")).toBeNull();
      expect(errorText()).toBe(
        "Design page failed to render: first draft failed",
      );

      // A good render is kept, and shown for the next error.
      state = "ok";
      rerender(show(1));
      await act(async () => {});
      state = "boom";
      rerender(show(2));
      expect(
        shell().querySelector("[data-design-last-good]")?.textContent,
      ).toBe("Trips");
    } finally {
      raf.mockRestore();
    }
  });

  test("applies ?theme=dark before the first paint", () => {
    history.replaceState(null, "", "/design?theme=dark");
    render(
      <DesignPage>
        <Page text="Trips" />
      </DesignPage>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

type Load = () => Promise<{ default: ComponentType }>;
const roots: reactDomClient.Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/**
 * Runs the `/design/__stream/dash` script here, as the plugin serves it, with
 * the page's import and Vite's HMR client stubbed. `published`: the server had
 * a version out when it served the page; `publishedNow`: it has one now.
 */
async function streamPage(
  published: boolean,
  first: ReturnType<Load>,
  publishedNow = published,
) {
  const html = (on: boolean) =>
    `<div id="root"${on ? " data-published" : ""}></div>`;
  document.body.innerHTML = html(published);
  // The page's HTML served again, as the host fetches it.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ text: async () => html(publishedNow) })),
  );
  const load = vi.fn<Load>(() => first);
  const handlers: Record<string, (data: object) => void> = {};
  const modules: Record<string, unknown> = {
    react,
    "react-dom/client": {
      createRoot: (el: HTMLElement) => {
        const root = reactDomClient.createRoot(el);
        roots.push(root);
        return root;
      },
    },
    "@databricks/appkit-ui/react/beta": { DesignPage },
  };
  const code = streamHostModule("dash")
    .replace(
      /^import \{([^}]*)\} from "([^"]+)";$/gm,
      (_, names, from) =>
        `const {${names}} = modules[${JSON.stringify(from)}];`,
    )
    .replace(/^import\.meta\.glob\(.*$/m, "")
    .replaceAll("import.meta.hot", "hot")
    .replace("import(/* @vite-ignore */", "load(");
  const hot = {
    on: (e: string, fn: (data: object) => void) => (handlers[e] = fn),
  };
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  new Function("modules", "hot", "load", code)(modules, hot, load);
  await settle();
  return {
    /** An `appkit:stream` publish, whose import gives `next`. */
    publish: async (next: ReturnType<Load>) => {
      load.mockImplementationOnce(() => next);
      handlers["appkit:stream"]({ name: "dash" });
      await settle();
    },
    /** Vite's `vite:afterUpdate`, once a hot update applied (the host retries 50 ms later). */
    afterUpdate: async () => {
      handlers["vite:afterUpdate"]({});
      await act(() => new Promise((r) => setTimeout(r, 100)));
    },
  };
}

// Vite's error for a module it can't serve (not published, or doesn't build).
const notFound = () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
const page = (Default: ComponentType) => Promise.resolve({ default: Default });
const errorText = () =>
  shell()?.querySelector("[data-design-error]")?.textContent;

/** A draft whose module hot-updates in place, as Fast Refresh does it. */
function hotDraft(text: string) {
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  function Draft() {
    const now = useSyncExternalStore(subscribe, () => text);
    if (now === "boom") throw new Error("boom");
    return <h1>{now}</h1>;
  }
  const edit = (next: string) =>
    act(() => {
      text = next;
      listeners.forEach((l) => l());
    });
  return { Draft, edit };
}

describe("stream page", () => {
  test("pending until a version is out; a failed import shows at once; a good publish renders", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = await streamPage(false, notFound());
    // Pending: nothing published yet, so no shell.
    expect(shell()).toBeNull();

    await stream.publish(
      Promise.reject(new ReferenceError("trips is not defined")),
    );
    expect(errorText()).toBe(
      "Design page failed to render: trips is not defined",
    );
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);

    await stream.publish(page(() => <h1>Trips</h1>));
    expect(errorText()).toBeUndefined();
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
    expect(screen.getByRole("heading").textContent).toBe("Trips");
  });

  test("opened after a version is out, a failed import is an error, not pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await streamPage(true, notFound());
    expect(errorText()).toBe(
      "Design page failed to render: Failed to fetch dynamically imported module",
    );
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);
  });

  test("a first publish missed before the host listened still shows its failed import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Served before the publish; its event came before the listener.
    await streamPage(
      false,
      Promise.reject(new ReferenceError("trips is not defined")),
      true,
    );
    expect(errorText()).toBe(
      "Design page failed to render: trips is not defined",
    );
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);
  });

  test("only the latest publish's import counts, whichever finishes first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const later = () => {
      let resolve!: (m: { default: ComponentType }) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<{ default: ComponentType }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const finish = (done: () => void) =>
      act(async () => {
        done();
        await new Promise((r) => setTimeout(r, 0));
      });
    // Three versions' imports in flight, the newest finishing first.
    const first = later();
    const second = later();
    const third = later();
    const stream = await streamPage(true, first.promise);
    await stream.publish(second.promise);
    await stream.publish(third.promise);
    await finish(() => third.reject(new Error("draft 3 failed")));
    expect(errorText()).toBe("Design page failed to render: draft 3 failed");
    // The older ones, a failure then a success, change nothing.
    await finish(() => first.reject(new Error("draft 1 failed")));
    expect(errorText()).toBe("Design page failed to render: draft 3 failed");
    await finish(() => second.resolve({ default: () => <h1>Draft 2</h1> }));
    expect(errorText()).toBe("Design page failed to render: draft 3 failed");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("rendered, then a broken update keeps the last good frame, then a fixed update renders again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const draft = hotDraft("Trips");
    const stream = await streamPage(true, page(draft.Draft));
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);

    await draft.edit("boom");
    expect(shell().querySelector("[data-design-last-good]")?.textContent).toBe(
      "Trips",
    );
    expect(errorText()).toBeUndefined();
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);

    await draft.edit("Trips today");
    await stream.afterUpdate();
    expect(shell().querySelector("[data-design-last-good]")).toBeNull();
    expect(shell().hasAttribute("data-design-rendered")).toBe(true);
    expect(screen.getByRole("heading").textContent).toBe("Trips today");
  });

  test("a page that throws before its first good render shows the message, not a blank frame", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await streamPage(
      true,
      page(() => {
        throw new Error("rows is undefined");
      }),
    );
    expect(errorText()).toBe("Design page failed to render: rows is undefined");
    expect(shell().hasAttribute("data-design-rendered")).toBe(false);
  });
});

describe("DraftPlaceholder", () => {
  test("renders a skeleton of the given shape", () => {
    const { container } = render(<DraftPlaceholder kind="chart" />);
    expect(
      container.querySelector(
        '[data-draft-placeholder="chart"] [data-slot="skeleton"]',
      ),
    ).not.toBeNull();
  });
});
