import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ThreadList } from "../thread-list";

const ISO = "2026-06-06T12:00:00.000Z";

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("<ThreadList>", () => {
  test("renders titles (with derived-empty fallback) and selects on click", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJson({
        threads: [
          {
            id: "t1",
            title: "Weather in Paris",
            messageCount: 2,
            createdAt: ISO,
            updatedAt: ISO,
          },
          {
            id: "t2",
            title: "",
            messageCount: 0,
            createdAt: ISO,
            updatedAt: ISO,
          },
        ],
      }),
    );
    const onSelect = vi.fn();
    render(<ThreadList onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText("Weather in Paris")));
    // Empty title falls back to a placeholder label.
    expect(screen.getByText("New conversation")).toBeTruthy();

    fireEvent.click(screen.getByText("Weather in Paris"));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  test('renders a "New" button only when onNewThread is provided', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({ threads: [] }));
    const onNewThread = vi.fn();
    const { rerender } = render(<ThreadList />);
    await waitFor(() => expect(screen.getByText("No conversations yet")));
    expect(screen.queryByText("+ New")).toBeNull();

    rerender(<ThreadList onNewThread={onNewThread} />);
    fireEvent.click(screen.getByText("+ New"));
    expect(onNewThread).toHaveBeenCalled();
  });
});
