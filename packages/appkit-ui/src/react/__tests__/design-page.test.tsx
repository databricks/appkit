import { act, cleanup, render, screen } from "@testing-library/react";
import * as react from "react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
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
 * Starts the `/design/__stream/dash` script on the `#root` here, as the plugin
 * serves it, with its imports and Vite's HMR client stubbed. Returns its HMR
 * event handlers.
 */
function startHost(load: Load) {
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
  new Function("modules", "hot", "load", code)(modules, hot, load);
  return handlers;
}

/**
 * Every transition between the states a builder reads from the DOM (pending,
 * rendered, last-good, error), on a design page and on a stream page.
 *
 * Page steps: `mount <mode>`, `draft <mode>` (the page changes in place, as a
 * hot update or its own state does it), `retry` (a new `resetKey`).
 * Stream steps: `open <html> <server>` (whether the HTML, and the server now,
 * say a version is out; the first import starts), `publish [done]` (the next
 * import starts), `import <n> <mode>` or `import <n> fail:<reason>` (import n
 * finishes), `draft <mode>`, `afterUpdate` (Vite's, after a hot update).
 * Modes: `show:<text>`, `empty`, `throw:<reason>`, `throw-value:<value>`,
 * `suspend`, `sync-fail:<text>:<reason>` (fails right after it commits, in the
 * same task), `async-fail:<text>:<reason>` (fails a moment later).
 *
 * After each step, the state it settles in. On every DOM change on the way,
 * what a builder must never see: two states at once, an empty error, the
 * pending fallback as the last good frame, or rendered beside the fallback.
 */
const failed = (reason: string) =>
  `error:Design page failed to render: ${reason}`;
type Row = {
  name: string;
  steps: [string, string][];
  errorFallback?: (e: Error) => ReactNode;
};
const transitions: Row[] = [
  // A design page's first render.
  {
    name: "first render: the page",
    steps: [["mount show:Trips", "rendered:Trips"]],
  },
  {
    name: "first render: an empty page counts",
    steps: [["mount empty", "rendered:"]],
  },
  {
    name: "first render throws",
    steps: [["mount throw:boom", failed("boom")]],
  },
  {
    name: "first render throws a string",
    steps: [
      ["mount throw-value:draft import failed", failed("draft import failed")],
    ],
  },
  {
    name: "first render throws null",
    steps: [["mount throw-value:null", failed("null")]],
  },
  {
    name: "first render throws, errorFallback shows nothing: the message",
    errorFallback: () => false,
    steps: [["mount throw:boom", failed("boom")]],
  },
  {
    name: "first render throws, errorFallback shows its text",
    errorFallback: (e) => `Oops: ${e.message}`,
    steps: [["mount throw:boom", "error:Oops: boom"]],
  },
  {
    name: "first render suspends, then shows",
    steps: [
      ["mount suspend", "pending:Loading"],
      ["draft show:Trips", "rendered:Trips"],
    ],
  },
  {
    name: "first render suspends, then throws: the error, not the fallback",
    steps: [
      ["mount suspend", "pending:Loading"],
      ["draft throw:boom", failed("boom")],
    ],
  },
  {
    name: "first commit, then a failure in the same task: its frame",
    steps: [["mount sync-fail:Trips:after commit", "last-good:Trips"]],
  },
  {
    name: "first commit, then a failure later: its frame",
    steps: [["mount async-fail:Trips:later", "last-good:Trips"]],
  },
  // Later renders.
  {
    name: "an update throws: the latest frame",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft show:Trips today", "rendered:Trips today"],
      ["draft throw:boom", "last-good:Trips today"],
    ],
  },
  {
    name: "an update commits, then fails in the same task: that update's frame",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft sync-fail:Trips today:after commit", "last-good:Trips today"],
    ],
  },
  {
    name: "an update commits, then fails later: that update's frame",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft async-fail:Trips today:later", "last-good:Trips today"],
    ],
  },
  {
    name: "an update suspends, then shows",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft suspend", "pending:Loading"],
      ["draft show:Trips today", "rendered:Trips today"],
    ],
  },
  {
    name: "an update suspends, then throws: the page's last frame, not the fallback",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft show:Trips today", "rendered:Trips today"],
      ["draft suspend", "pending:Loading"],
      ["draft throw:boom", "last-good:Trips today"],
    ],
  },
  {
    name: "rendered, a retry renders again",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["retry", "rendered:Trips"],
    ],
  },
  // Retries from last-good.
  {
    name: "last-good, the fix isn't shown until a retry",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft show:Fixed", "last-good:Trips"],
      ["retry", "rendered:Fixed"],
    ],
  },
  {
    name: "last-good, a retry throws again: the same frame",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["retry", "last-good:Trips"],
    ],
  },
  {
    name: "last-good, a retry commits then fails in the same task: the new frame",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft sync-fail:Fixed:again", "last-good:Trips"],
      ["retry", "last-good:Fixed"],
    ],
  },
  {
    name: "last-good, a retry suspends, then shows",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft suspend", "last-good:Trips"],
      ["retry", "pending:Loading"],
      ["draft show:Fixed", "rendered:Fixed"],
    ],
  },
  {
    name: "last-good, a retry suspends, then throws: the old frame, not the fallback",
    steps: [
      ["mount show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft suspend", "last-good:Trips"],
      ["retry", "pending:Loading"],
      ["draft throw:bang", "last-good:Trips"],
    ],
  },
  // Retries from error.
  {
    name: "error, a retry shows",
    steps: [
      ["mount throw:boom", failed("boom")],
      ["draft show:Trips", failed("boom")],
      ["retry", "rendered:Trips"],
    ],
  },
  {
    name: "error, a retry throws another: its message",
    steps: [
      ["mount throw:boom", failed("boom")],
      ["draft throw:bang", failed("boom")],
      ["retry", failed("bang")],
    ],
  },
  {
    name: "error, a retry commits then fails in the same task: its frame",
    steps: [
      ["mount throw:boom", failed("boom")],
      ["draft sync-fail:Trips:after commit", failed("boom")],
      ["retry", "last-good:Trips"],
    ],
  },
  {
    name: "error, a retry suspends, then shows",
    steps: [
      ["mount throw:boom", failed("boom")],
      ["draft suspend", failed("boom")],
      ["retry", "pending:Loading"],
      ["draft show:Trips", "rendered:Trips"],
    ],
  },
  {
    name: "error, a retry suspends, then throws: the error, not the fallback",
    steps: [
      ["mount throw:boom", failed("boom")],
      ["draft suspend", failed("boom")],
      ["retry", "pending:Loading"],
      ["draft throw:bang", failed("bang")],
    ],
  },
  // A stream page: imports and publishes.
  {
    name: "stream: nothing published is pending, a good publish shows it",
    steps: [
      ["open 0 0", "pending"],
      ["import 0 fail:Failed to fetch dynamically imported module", "pending"],
      ["publish", "pending"],
      ["import 1 show:Trips", "rendered:Trips"],
    ],
  },
  {
    name: "stream: a failed first publish shows at once, a good one clears it",
    steps: [
      ["open 0 0", "pending"],
      ["import 0 fail:Failed to fetch dynamically imported module", "pending"],
      ["publish", "pending"],
      ["import 1 fail:trips is not defined", failed("trips is not defined")],
      ["publish", failed("trips is not defined")],
      ["import 2 show:Trips", "rendered:Trips"],
    ],
  },
  {
    name: "stream: a failed publish, then another: its message",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 fail:boom", failed("boom")],
      ["publish", failed("boom")],
      ["import 1 fail:bang", failed("bang")],
    ],
  },
  {
    name: "stream: opened after a version is out, a failed import shows",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 fail:boom", failed("boom")],
    ],
  },
  {
    name: "stream: a publish missed before the host listened, the server is asked",
    steps: [
      ["open 0 1", "pending"],
      ["import 0 fail:boom", failed("boom")],
    ],
  },
  {
    name: "stream: the imported page throws on its first render",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 throw:rows is undefined", failed("rows is undefined")],
    ],
  },
  {
    name: "stream: the imported page suspends, then shows",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 suspend", "pending"],
      ["draft show:Trips", "rendered:Trips"],
    ],
  },
  {
    name: "stream: out of order, the latest failure stands",
    steps: [
      ["open 1 1", "pending"],
      ["publish", "pending"],
      ["publish", "pending"],
      ["import 2 fail:draft 3 failed", failed("draft 3 failed")],
      ["import 0 fail:draft 1 failed", failed("draft 3 failed")],
      ["import 1 show:Draft 2", failed("draft 3 failed")],
    ],
  },
  {
    name: "stream: out of order, the latest success stands",
    steps: [
      ["open 1 1", "pending"],
      ["publish", "pending"],
      ["import 1 show:Trips", "rendered:Trips"],
      ["import 0 fail:old", "rendered:Trips"],
    ],
  },
  {
    name: "stream: a publish while it shows starts no new import",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 show:Trips", "rendered:Trips"],
      ["publish", "rendered:Trips"],
      ["draft show:Trips today", "rendered:Trips today"],
    ],
  },
  {
    name: "stream: a broken hot update keeps the last frame, a fixed one renders",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft show:Trips today", "last-good:Trips"],
      ["afterUpdate", "rendered:Trips today"],
    ],
  },
  {
    name: "stream: a failed import's error stays on a retry",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 fail:boom", failed("boom")],
      ["afterUpdate", failed("boom")],
    ],
  },
  {
    name: "stream: the finished file remounts the page fresh",
    steps: [
      ["open 1 1", "pending"],
      ["import 0 show:Trips", "rendered:Trips"],
      ["draft throw:boom", "last-good:Trips"],
      ["draft show:Final", "last-good:Trips"],
      ["publish done", "rendered:Final"],
    ],
  },
];

/** The page's behaviour, changed in place; a suspended render wakes on a change. */
function draftStore(initial: string) {
  let mode = initial;
  let wake = () => {};
  let gate = new Promise<void>((r) => (wake = r));
  const listeners = new Set<() => void>();
  return {
    get: () => mode,
    gate: () => gate,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    set(next: string) {
      wake();
      gate = new Promise<void>((r) => (wake = r));
      mode = next;
      listeners.forEach((l) => l());
    },
  };
}

function draftPage(store: ReturnType<typeof draftStore>) {
  return function Draft() {
    const mode = useSyncExternalStore(store.subscribe, store.get);
    const [kind, text = "", reason = ""] = mode.split(":");
    const [broke, setBroke] = useState<string | null>(null);
    useLayoutEffect(() => {
      if (kind === "sync-fail") setBroke(mode);
    }, [kind, mode]);
    useEffect(() => {
      if (kind !== "async-fail") return;
      const t = setTimeout(() => setBroke(mode), 20);
      return () => clearTimeout(t);
    }, [kind, mode]);
    if (broke === mode) throw new Error(reason);
    if (kind === "throw") throw new Error(text);
    if (kind === "throw-value") throw text === "null" ? null : text;
    if (kind === "suspend") throw store.gate();
    if (kind === "empty") return null;
    return <h1>{text}</h1>;
  };
}

/** The state a builder reads from the DOM, with what it shows. */
function stateOf() {
  const shell = document.querySelector("[data-design-page]");
  if (!shell) return "pending";
  const lastGood = shell.querySelector("[data-design-last-good]");
  const error = shell.querySelector("[data-design-error]");
  const states = [
    shell.hasAttribute("data-design-rendered") &&
      `rendered:${shell.textContent}`,
    lastGood && `last-good:${lastGood.textContent}`,
    error && `error:${error.textContent}`,
  ].filter(Boolean);
  if (states.length) return states.join(" + ");
  return shell.textContent?.includes("Loading") ? "pending:Loading" : "pending";
}

function neverSeen(state: string) {
  if (state.includes(" + ")) return "two states at once";
  if (state === "error:") return "an empty error";
  if (state.startsWith("last-good:") && state.includes("Loading")) {
    return "the fallback as the last good frame";
  }
  if (state.startsWith("rendered:") && state.includes("Loading")) {
    return "rendered beside the fallback";
  }
  return null;
}

describe("design page states", () => {
  const rows = transitions.flatMap((row) =>
    (["visible", "hidden"] as const).map((frame) => ({ ...row, frame })),
  );
  test.each(rows)("$name ($frame)", async ({ steps, errorFallback, frame }) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A hidden frame (a builder's preview kept out of sight) gets no animation frames.
    const raf =
      frame === "hidden"
        ? vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
        : null;
    // Outside act(): effects and retries run when React schedules them, as in a browser.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const problem = neverSeen(stateOf());
      if (problem) seen.push(`${problem}: ${stateOf()}`);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const stores: ReturnType<typeof draftStore>[] = [];
    const page = (mode: string) => {
      const store = draftStore(mode);
      stores.push(store);
      return draftPage(store);
    };
    let root: reactDomClient.Root | undefined;
    let resetKey = 0;
    let Draft: ComponentType = () => null;
    const show = () =>
      root?.render(
        <DesignPage
          resetKey={resetKey}
          pendingFallback={<p>Loading</p>}
          errorFallback={errorFallback}
        >
          <Draft />
        </DesignPage>,
      );
    const imports: {
      resolve: (m: { default: ComponentType }) => void;
      reject: (e: Error) => void;
    }[] = [];
    const load = vi.fn<Load>(
      () => new Promise((resolve, reject) => imports.push({ resolve, reject })),
    );
    let handlers: Record<string, (data: object) => void> = {};
    const path: string[] = [];
    try {
      for (const [step, expected] of steps) {
        const [verb, ...args] = step.split(" ");
        const rest = args.join(" ");
        let ms = 50;
        if (verb === "mount") {
          Draft = page(rest);
          root = reactDomClient.createRoot(
            document.body.appendChild(document.createElement("div")),
          );
          roots.push(root);
          show();
        } else if (verb === "draft") {
          // Leaving a suspended render: React may hold the reveal back a moment.
          if (stores.some((s) => s.get() === "suspend")) ms = 400;
          for (const s of stores) s.set(rest);
        } else if (verb === "retry") {
          resetKey++;
          show();
        } else if (verb === "open") {
          const html = (on: string) =>
            `<div id="root"${on === "1" ? " data-published" : ""}></div>`;
          document.body.innerHTML = html(args[0]);
          vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ text: async () => html(args[1]) })),
          );
          handlers = startHost(load);
        } else if (verb === "publish") {
          handlers["appkit:stream"]({ name: "dash", done: rest === "done" });
          // The finished file remounts the page a second later.
          if (rest === "done") ms = 1200;
        } else if (verb === "import") {
          const [n, ...mode] = rest.split(" ");
          const result = mode.join(" ");
          if (result.startsWith("fail:")) {
            imports[Number(n)].reject(new Error(result.slice(5)));
          } else {
            imports[Number(n)].resolve({ default: page(result) });
          }
        } else if (verb === "afterUpdate") {
          handlers["vite:afterUpdate"]({});
          ms = 150;
        }
        await new Promise((r) => setTimeout(r, ms));
        path.push(`${step} -> ${stateOf()}`);
        expect(path.at(-1)).toBe(`${step} -> ${expected}`);
      }
      expect(seen).toEqual([]);
    } finally {
      observer.disconnect();
      raf?.mockRestore();
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
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
