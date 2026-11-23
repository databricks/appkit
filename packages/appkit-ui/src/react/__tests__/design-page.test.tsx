import { act, cleanup, render, screen } from "@testing-library/react";
import * as react from "react";
import { type ComponentType, useLayoutEffect } from "react";
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
});

/**
 * Runs the `/design/__stream/dash` script here, as the plugin serves it, with
 * the page's import and Vite's HMR client stubbed. `published`: the server had
 * a version out when it served the page.
 */
async function streamPage(published: boolean, first: ReturnType<Load>) {
  document.body.innerHTML = `<div id="root"${published ? " data-published" : ""}></div>`;
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
  };
}

// Vite's error for a module it can't serve (not published, or doesn't build).
const notFound = () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
const page = (Default: ComponentType) => Promise.resolve({ default: Default });
const errorText = () =>
  shell()?.querySelector("[data-design-error]")?.textContent;

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
