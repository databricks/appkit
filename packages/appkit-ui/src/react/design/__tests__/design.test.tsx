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
import { DesignPicker } from "../design-picker";
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

describe("DesignPicker", () => {
  test("a finished send keeps picks added while it was in flight", async () => {
    let release!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response("{}", { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <>
        <button type="button">First action</button>
        <button type="button">Second action</button>
        <div id="appkit-design-picker">
          <DesignPicker />
        </div>
      </>,
    );

    fireEvent.click(screen.getByText("Select"));
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
    vi.unstubAllGlobals();
  });
});
