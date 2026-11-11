import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DesignPage, DraftPlaceholder } from "../design-page";

type Host = { blockers: number; changed?: () => void };
const win = window as { __appkitDesign?: Host };

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

  test("shows the error when nothing rendered yet, or the given fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <DesignPage>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(screen.getByText(/Design page failed to render: boom/)).toBeTruthy();
    rerender(
      <DesignPage errorFallback={() => null} resetKey={1}>
        <Page text="boom" />
      </DesignPage>,
    );
    expect(screen.queryByText(/failed to render/)).toBeNull();
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
