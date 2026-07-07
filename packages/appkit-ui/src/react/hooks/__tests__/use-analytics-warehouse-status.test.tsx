import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }
});

const mockConnectSSE = vi.fn().mockImplementation((_opts: unknown) => {
  return new Promise<void>(() => {});
});

vi.mock("@/js", () => ({
  ArrowClient: {
    fetchArrow: vi.fn(),
    processArrowBuffer: vi.fn(),
  },
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

vi.mock("../use-query-hmr", () => ({
  useQueryHMR: () => {},
}));

import { ResourceStatusIndicator } from "../../resource-status-indicator";
import { useAnalyticsQuery } from "../use-analytics-query";
import {
  ResourceStatusProvider,
  useResourceStatus,
  useResourceStatusPublisher,
} from "../use-resource-status";

function queryIndicatorToast(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sonner-toast]");
}

/**
 * These tests cover the analytics-warehouse adapter end-to-end: the publisher
 * inside `useAnalyticsQuery` should map `WarehouseStatus` payloads onto the
 * generic resource-status store with the correct kind, severity, and
 * `kindHint` registration so kind-filtered consumers see the right shape.
 *
 * The generic store itself is exercised in `use-resource-status.test.tsx`;
 * we don't re-test it here.
 */
describe("useAnalyticsQuery + ResourceStatusProvider integration", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("does not show the indicator toast before a real warehouse status arrives", async () => {
    mockConnectSSE.mockImplementationOnce(() => new Promise<void>(() => {}));

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    render(
      <ResourceStatusProvider>
        <Chart />
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );

    await waitFor(() => {
      expect(queryIndicatorToast()).toBeNull();
    });
  });

  test("does not show the indicator toast when the first warehouse status is RUNNING", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    render(
      <ResourceStatusProvider>
        <Chart />
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "RUNNING", elapsedMs: 0 },
        }),
      });
    });

    await waitFor(() => {
      expect(queryIndicatorToast()).toBeNull();
    });
  });

  test("registers a warehouse-kind slot on mount even before any status arrives", async () => {
    mockConnectSSE.mockImplementationOnce(() => new Promise<void>(() => {}));

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return <span data-testid="active">{agg.activeCount}</span>;
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Chart />
        <Aggregate />
      </ResourceStatusProvider>,
    );

    // The hook publishes `null` on mount via the kindHint, so a kind-filtered
    // consumer counts the slot before the first SSE event lands.
    await waitFor(() => {
      expect(getByTestId("active").textContent).toBe("1");
    });
  });

  test("maps STARTING to a pending warehouse status and surfaces it as worst", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return (
        <>
          <span data-testid="state">{agg.worst?.state ?? "null"}</span>
          <span data-testid="severity">{agg.worst?.severity ?? "null"}</span>
          <span data-testid="labels">{agg.affectedLabels.join(",")}</span>
        </>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Chart />
        <Aggregate />
      </ResourceStatusProvider>,
    );

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 1200 },
        }),
      });
    });

    await waitFor(() => {
      expect(getByTestId("state").textContent).toBe("STARTING");
    });
    expect(getByTestId("severity").textContent).toBe("pending");
    expect(getByTestId("labels").textContent).toBe("chart_one");
  });

  test("maps DELETED to error severity", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return (
        <span data-testid="severity">{agg.worst?.severity ?? "null"}</span>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Chart />
        <Aggregate />
      </ResourceStatusProvider>,
    );

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "DELETED", elapsedMs: 0 },
        }),
      });
    });

    await waitFor(() => {
      expect(getByTestId("severity").textContent).toBe("error");
    });
  });

  test("clears the slot's status when RUNNING arrives but keeps it registered", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return (
        <>
          <span data-testid="active">{agg.activeCount}</span>
          <span data-testid="worst">{agg.worst?.state ?? "null"}</span>
        </>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Chart />
        <Aggregate />
      </ResourceStatusProvider>,
    );

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 100 },
        }),
      });
    });
    await waitFor(() => {
      expect(getByTestId("worst").textContent).toBe("STARTING");
    });

    act(() => {
      onMessage?.({
        id: "2",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "RUNNING", elapsedMs: 4500 },
        }),
      });
    });

    // RUNNING clears the entry's status (no longer the worst) but the slot
    // stays registered until the query completes or unmounts.
    await waitFor(() => {
      expect(getByTestId("worst").textContent).toBe("null");
    });
    expect(getByTestId("active").textContent).toBe("1");
  });

  test("anchors startedAt to the first non-null status so elapsed advances monotonically", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    const seen: number[] = [];
    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      const startedAt = agg.worst?.startedAt;
      if (startedAt !== undefined && seen[seen.length - 1] !== startedAt) {
        seen.push(startedAt);
      }
      return (
        <span data-testid="started">{agg.worst?.startedAt ?? "null"}</span>
      );
    }

    render(
      <ResourceStatusProvider>
        <Chart />
        <Aggregate />
      </ResourceStatusProvider>,
    );

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 1000 },
        }),
      });
    });
    await waitFor(() => expect(seen.length).toBe(1));

    act(() => {
      onMessage?.({
        id: "2",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 4500 },
        }),
      });
    });
    act(() => {
      onMessage?.({
        id: "3",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 9000 },
        }),
      });
    });

    // All three events share the same anchored startedAt.
    expect(seen).toHaveLength(1);
  });

  test("kindHint-only mutation notifies kind-filtered consumers via the version counter", async () => {
    // A status-less publish (toggling kindHint) bumps `version` so
    // kind-filtered consumers re-derive even when no aggregate field changes.
    function Probe() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return <span data-testid="version">{agg.version}</span>;
    }

    const publisherStore: {
      current: ((status: null) => void) | null;
    } = { current: null };
    function Publisher() {
      const { publish } = useResourceStatusPublisher("p1", "label", {
        kindHint: "warehouse",
      });
      publisherStore.current = publish as (status: null) => void;
      return null;
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Publisher />
        <Probe />
      </ResourceStatusProvider>,
    );

    const v0 = Number(getByTestId("version").textContent);
    act(() => publisherStore.current?.(null));
    await waitFor(() => {
      expect(Number(getByTestId("version").textContent)).toBeGreaterThan(v0);
    });
  });

  test("unmounts release the slot from the kind-filtered aggregate", async () => {
    let onMessage: ((msg: { id: string; data: string }) => void) | null = null;
    mockConnectSSE.mockImplementationOnce((opts: any) => {
      onMessage = opts.onMessage;
      return new Promise<void>(() => {});
    });

    function Chart() {
      useAnalyticsQuery("chart_one" as any);
      return null;
    }

    function Aggregate() {
      const agg = useResourceStatus({ kind: "warehouse" });
      return <span data-testid="active">{agg.activeCount}</span>;
    }

    function App({ showChart }: { showChart: boolean }) {
      return (
        <ResourceStatusProvider>
          {showChart ? <Chart /> : null}
          <Aggregate />
        </ResourceStatusProvider>
      );
    }

    const { rerender, getByTestId } = render(<App showChart={true} />);

    act(() => {
      onMessage?.({
        id: "1",
        data: JSON.stringify({
          type: "warehouse_status",
          status: { state: "STARTING", elapsedMs: 100 },
        }),
      });
    });

    await waitFor(() => {
      expect(getByTestId("active").textContent).toBe("1");
    });

    rerender(<App showChart={false} />);

    await waitFor(() => {
      expect(getByTestId("active").textContent).toBe("0");
    });
  });
});
