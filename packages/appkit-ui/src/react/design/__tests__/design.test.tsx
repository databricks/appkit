import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { forwardRef, memo, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DesignCanvas } from "../design-canvas";
import { inspectElement } from "../inspect";

afterEach(cleanup);

function LiveCard({ count }: { count: number }) {
  return <button type="button">Count: {count}</button>;
}

function Parent() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        inc
      </button>
      <LiveCard count={count} />
    </div>
  );
}

describe("inspectElement", () => {
  test("reports the committed props after every update", () => {
    render(<Parent />);
    for (let i = 1; i <= 5; i++) {
      act(() => screen.getByText("inc").click());
      const info = inspectElement(screen.getByText(`Count: ${i}`));
      expect(info.component).toBe("LiveCard");
      expect(info.props).toEqual({ count: i });
    }
  });

  test("takes the source of a component that never forwards it to the DOM", () => {
    // Stand-in for a dependency component the dev transform tags at its call site.
    const LibButton = ({ label }: { label: string }) => (
      <button type="button">{label}</button>
    );
    const props = { "data-appkit-source": "client/src/App.tsx:7:4" };
    render(
      <main data-source="client/src/App.tsx:3:2">
        <LibButton label="Library button" {...props} />
      </main>,
    );
    const info = inspectElement(screen.getByText("Library button"));
    expect(info.source).toBe("client/src/App.tsx:7:4");
    expect(info.props).toEqual({ label: "Library button" });
  });
});

describe("DesignCanvas", () => {
  test("renders function, memo and forwardRef exports", () => {
    const MemoDraft = memo(() => <p>memo draft</p>);
    const RefDraft = forwardRef<HTMLParagraphElement>((_, ref) => (
      <p ref={ref}>ref draft</p>
    ));
    render(
      <DesignCanvas
        modules={{
          "/src/design/Drafts.tsx": {
            Plain: () => <p>plain draft</p>,
            MemoDraft,
            RefDraft,
            helper: () => null,
            CONSTANT: 1,
          },
        }}
      />,
    );
    expect(screen.getByText("plain draft")).toBeTruthy();
    expect(screen.getByText("memo draft")).toBeTruthy();
    expect(screen.getByText("ref draft")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
  });
});

function renderCanvas(builderOrigins?: string[]) {
  render(
    <DesignCanvas
      builderOrigins={builderOrigins}
      modules={{
        "/src/design/Actions.tsx": {
          Actions: () => (
            <>
              <button type="button">First action</button>
              <button type="button">Second action</button>
            </>
          ),
        },
      }}
    />,
  );
}

const okResponse = () =>
  new Response(
    JSON.stringify({
      ok: true,
      selection: {
        id: "sel-1",
        elements: [{ screenshot: ".appkit/design-screenshots/sel-1-0.jpeg" }],
      },
    }),
    { status: 200 },
  );

describe("DesignPicker", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("Alt+S toggles selecting from the keyboard", () => {
    renderCanvas();
    const toggle = screen.getByRole("button", { name: /Select/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(document, { code: "KeyS", altKey: true });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document, { code: "KeyS", altKey: true });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("Escape stops selecting without reaching the page (e.g. an open dialog)", () => {
    renderCanvas();
    const pageEscape = vi.fn();
    document.addEventListener("keydown", pageEscape, true);
    try {
      const toggle = screen.getByRole("button", { name: /Select/ });
      fireEvent.click(toggle);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(pageEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageEscape, true);
    }
  });

  test("a finished send keeps picks added while it was in flight", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(okResponse());
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCanvas();

    fireEvent.click(screen.getByRole("button", { name: /Select/ }));
    fireEvent.click(screen.getByText("First action"));
    fireEvent.click(screen.getByText("Send 1 to agent"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Second action"));
    expect(screen.getByText("Send 2 to agent")).toBeTruthy();

    await act(async () => release());

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.elements.map((e: { text: string }) => e.text)).toEqual([
      "First action",
    ]);
    await waitFor(() =>
      expect(screen.getByText("Send 1 to agent")).toBeTruthy(),
    );
  });

  test("posts the selection to the embedding builder, only to its origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse()),
    );
    const postMessage = vi.fn();
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage },
    });
    try {
      renderCanvas(["https://builder.example.com"]);
      fireEvent.click(screen.getByRole("button", { name: /Select/ }));
      fireEvent.click(screen.getByText("First action"));
      fireEvent.change(screen.getByPlaceholderText(/What should change/), {
        target: { value: "make it primary" },
      });
      fireEvent.click(screen.getByText("Send 1 to agent"));
      await screen.findByText("Sent to the app builder.");

      expect(postMessage).toHaveBeenCalledTimes(1);
      const [message, origin] = postMessage.mock.calls[0];
      expect(origin).toBe("https://builder.example.com");
      expect(message).toMatchObject({
        type: "appkit:design-selection",
        version: 1,
        id: "sel-1",
        note: "make it primary",
        selections: [
          {
            text: "First action",
            screenshotUrl: `${location.origin}/api/design/screenshots/sel-1-0.jpeg`,
          },
        ],
      });
    } finally {
      if (parent) Object.defineProperty(window, "parent", parent);
    }
  });

  test("without a builder origin it only saves to the file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse()),
    );
    const postMessage = vi.fn();
    const parent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage },
    });
    try {
      renderCanvas();
      fireEvent.click(screen.getByRole("button", { name: /Select/ }));
      fireEvent.click(screen.getByText("First action"));
      fireEvent.click(screen.getByText("Send 1 to agent"));
      await screen.findByText(/Saved to/);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      if (parent) Object.defineProperty(window, "parent", parent);
    }
  });
});
