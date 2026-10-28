import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useDesignReady } from "../use-design-ready";

type Host = { blockers: number; changed?: () => void };
const win = window as { __appkitDesign?: Host };

function Probe({ ready }: { ready?: boolean }) {
  useDesignReady(ready);
  return null;
}

afterEach(() => {
  cleanup();
  delete win.__appkitDesign;
});

describe("useDesignReady", () => {
  test("holds readiness while false and releases it, notifying the page", () => {
    const changed = vi.fn();
    win.__appkitDesign = { blockers: 0, changed };

    const { rerender, unmount } = render(<Probe ready={false} />);
    expect(win.__appkitDesign.blockers).toBe(1);

    rerender(<Probe ready />);
    expect(win.__appkitDesign.blockers).toBe(0);
    expect(changed).toHaveBeenCalledTimes(1);

    rerender(<Probe ready={false} />);
    unmount();
    expect(win.__appkitDesign.blockers).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test("ready by default", () => {
    win.__appkitDesign = { blockers: 0 };
    render(<Probe />);
    expect(win.__appkitDesign.blockers).toBe(0);
  });

  test("does nothing outside /design", () => {
    expect(() => render(<Probe ready={false} />)).not.toThrow();
    expect(win.__appkitDesign).toBeUndefined();
  });
});
