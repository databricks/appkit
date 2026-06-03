import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ResourceStatusIndicator } from "../../resource-status-indicator";
import {
  type ResourceStatus,
  ResourceStatusProvider,
  useResourceStatus,
  useResourceStatusPublisher,
} from "../use-resource-status";

afterEach(() => {
  cleanup();
});

function makeStatus(
  overrides: Partial<ResourceStatus> & Pick<ResourceStatus, "kind" | "state">,
): ResourceStatus {
  return {
    severity: "pending",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("useResourceStatus / useResourceStatusPublisher", () => {
  test("returns the empty/idle aggregate when no provider is mounted", () => {
    const { result } = renderHook(() => useResourceStatus());
    expect(result.current).toEqual({
      worst: null,
      byKind: {},
      affectedLabels: [],
      activeCount: 0,
      elapsedMs: 0,
      version: 0,
    });
  });

  test("aggregates statuses across kinds, picking the worst by severity", async () => {
    function Publishers() {
      const { publish: pubA } = useResourceStatusPublisher("a", "lakebase-a");
      const { publish: pubB } = useResourceStatusPublisher("b", "warehouse-b");
      const aggregate = useResourceStatus();
      return (
        <div>
          <span data-testid="worst-kind">
            {aggregate.worst?.kind ?? "none"}
          </span>
          <span data-testid="worst-state">
            {aggregate.worst?.state ?? "none"}
          </span>
          <span data-testid="active">{aggregate.activeCount}</span>
          <span data-testid="labels">{aggregate.affectedLabels.join(",")}</span>
          <button
            type="button"
            data-testid="pub-pending-a"
            onClick={() => {
              pubA(
                makeStatus({
                  kind: "lakebase",
                  state: "STARTING",
                  severity: "pending",
                }),
              );
            }}
          />
          <button
            type="button"
            data-testid="pub-error-b"
            onClick={() => {
              pubB(
                makeStatus({
                  kind: "warehouse",
                  state: "DELETED",
                  severity: "error",
                }),
              );
            }}
          />
        </div>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Publishers />
      </ResourceStatusProvider>,
    );

    // a: lakebase pending
    act(() => {
      getByTestId("pub-pending-a").click();
    });
    await waitFor(() => {
      expect(getByTestId("worst-kind").textContent).toBe("lakebase");
    });
    expect(getByTestId("worst-state").textContent).toBe("STARTING");
    expect(getByTestId("active").textContent).toBe("1");
    expect(getByTestId("labels").textContent).toBe("lakebase-a");

    // b: warehouse error → outranks pending
    act(() => {
      getByTestId("pub-error-b").click();
    });
    await waitFor(() => {
      expect(getByTestId("worst-kind").textContent).toBe("warehouse");
    });
    expect(getByTestId("worst-state").textContent).toBe("DELETED");
    expect(getByTestId("active").textContent).toBe("2");
    expect(getByTestId("labels").textContent).toBe("lakebase-a,warehouse-b");
  });

  test("filters the aggregate to a single kind", async () => {
    function Publishers() {
      const { publish: pubA } = useResourceStatusPublisher("a", "lakebase-a");
      const { publish: pubB } = useResourceStatusPublisher("b", "warehouse-b");
      const warehouseAgg = useResourceStatus({ kind: "warehouse" });
      return (
        <div>
          <span data-testid="warehouse-state">
            {warehouseAgg.worst?.state ?? "none"}
          </span>
          <span data-testid="warehouse-active">{warehouseAgg.activeCount}</span>
          <button
            type="button"
            data-testid="pub-lakebase"
            onClick={() => {
              pubA(
                makeStatus({
                  kind: "lakebase",
                  state: "STARTING",
                  severity: "pending",
                }),
              );
            }}
          />
          <button
            type="button"
            data-testid="pub-warehouse"
            onClick={() => {
              pubB(
                makeStatus({
                  kind: "warehouse",
                  state: "STOPPED",
                  severity: "pending",
                }),
              );
            }}
          />
        </div>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Publishers />
      </ResourceStatusProvider>,
    );

    // Lakebase publishes — warehouse-scoped aggregate stays empty.
    act(() => {
      getByTestId("pub-lakebase").click();
    });
    await waitFor(() => {
      expect(getByTestId("warehouse-state").textContent).toBe("none");
    });

    // Warehouse publishes — warehouse-scoped aggregate lights up.
    act(() => {
      getByTestId("pub-warehouse").click();
    });
    await waitFor(() => {
      expect(getByTestId("warehouse-state").textContent).toBe("STOPPED");
    });
    expect(getByTestId("warehouse-active").textContent).toBe("1");
  });

  test("kindHint keeps null-status slots associated with their kind", async () => {
    function Publisher() {
      const { publish } = useResourceStatusPublisher("a", "x", {
        kindHint: "lakebase",
      });
      const lakebase = useResourceStatus({ kind: "lakebase" });
      return (
        <div>
          <span data-testid="lakebase-active">{lakebase.activeCount}</span>
          <button
            type="button"
            data-testid="register"
            onClick={() => {
              publish(null);
            }}
          />
        </div>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <Publisher />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("register").click();
    });
    await waitFor(() => {
      expect(getByTestId("lakebase-active").textContent).toBe("1");
    });
  });

  test("unpublish removes the entry from the aggregate", async () => {
    function App() {
      const { publish, unpublish } = useResourceStatusPublisher("a", "x");
      const aggregate = useResourceStatus();
      return (
        <div>
          <span data-testid="active">{aggregate.activeCount}</span>
          <span data-testid="state">{aggregate.worst?.state ?? "none"}</span>
          <button
            type="button"
            data-testid="pub"
            onClick={() => {
              publish(
                makeStatus({
                  kind: "warehouse",
                  state: "STOPPED",
                  severity: "pending",
                }),
              );
            }}
          />
          <button
            type="button"
            data-testid="unpub"
            onClick={() => {
              unpublish();
            }}
          />
        </div>
      );
    }

    const { getByTestId } = render(
      <ResourceStatusProvider>
        <App />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("pub").click();
    });
    await waitFor(() => {
      expect(getByTestId("state").textContent).toBe("STOPPED");
    });

    act(() => {
      getByTestId("unpub").click();
    });
    await waitFor(() => {
      expect(getByTestId("state").textContent).toBe("none");
    });
    expect(getByTestId("active").textContent).toBe("0");
  });
});

describe("ResourceStatusIndicator", () => {
  test("renders nothing when the aggregate is empty", () => {
    const { container } = render(
      <ResourceStatusProvider>
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );
    expect(container.children.length).toBe(0);
  });

  test("renders kind-specific copy for known kinds (warehouse)", async () => {
    function Trigger() {
      const { publish } = useResourceStatusPublisher("a", "my_chart");
      return (
        <button
          type="button"
          data-testid="pub"
          onClick={() => {
            publish(
              makeStatus({
                kind: "warehouse",
                state: "STARTING",
                severity: "pending",
              }),
            );
          }}
        />
      );
    }

    const { getByTestId, getByRole } = render(
      <ResourceStatusProvider>
        <Trigger />
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("pub").click();
    });

    const node = await waitFor(() => getByRole("status"));
    expect(node.dataset.resourceKind).toBe("warehouse");
    expect(node.dataset.resourceState).toBe("STARTING");
    expect(node.textContent).toMatch(/warming up|warehouse/i);
  });

  test("falls back to a generic message for unknown kinds", async () => {
    function Trigger() {
      const { publish } = useResourceStatusPublisher("a", "my_thing");
      return (
        <button
          type="button"
          data-testid="pub"
          onClick={() => {
            publish(
              makeStatus({
                kind: "model-endpoint",
                state: "COLD_START",
                severity: "pending",
              }),
            );
          }}
        />
      );
    }

    const { getByTestId, getByRole } = render(
      <ResourceStatusProvider>
        <Trigger />
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("pub").click();
    });

    const node = await waitFor(() => getByRole("status"));
    expect(node.dataset.resourceKind).toBe("model-endpoint");
    // Humanized kind name (Model Endpoint) appears in the title.
    expect(node.textContent).toMatch(/Model Endpoint/i);
  });

  test("uses the destructive treatment for error severity", async () => {
    function Trigger() {
      const { publish } = useResourceStatusPublisher("a", "my_thing");
      return (
        <button
          type="button"
          data-testid="pub"
          onClick={() => {
            publish(
              makeStatus({
                kind: "warehouse",
                state: "DELETED",
                severity: "error",
                summary: "It is gone",
              }),
            );
          }}
        />
      );
    }

    const { getByTestId, getByRole } = render(
      <ResourceStatusProvider>
        <Trigger />
        <ResourceStatusIndicator />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("pub").click();
    });

    const node = await waitFor(() => getByRole("alert"));
    expect(node.dataset.resourceSeverity).toBe("error");
    expect(node.dataset.resourceState).toBe("DELETED");
  });

  test("kind prop scopes to a single kind", async () => {
    function Trigger() {
      const { publish: pubLake } = useResourceStatusPublisher("a", "x");
      const { publish: pubWh } = useResourceStatusPublisher("b", "y");
      return (
        <div>
          <button
            type="button"
            data-testid="pub-lake"
            onClick={() => {
              pubLake(
                makeStatus({
                  kind: "lakebase",
                  state: "STARTING",
                  severity: "pending",
                }),
              );
            }}
          />
          <button
            type="button"
            data-testid="pub-wh"
            onClick={() => {
              pubWh(
                makeStatus({
                  kind: "warehouse",
                  state: "STARTING",
                  severity: "pending",
                }),
              );
            }}
          />
        </div>
      );
    }

    const { getByTestId, queryByRole, getByRole } = render(
      <ResourceStatusProvider>
        <Trigger />
        <ResourceStatusIndicator kind="warehouse" />
      </ResourceStatusProvider>,
    );

    // Lakebase pending — warehouse-scoped indicator stays hidden.
    act(() => {
      getByTestId("pub-lake").click();
    });
    expect(queryByRole("status")).toBeNull();

    // Warehouse pending — indicator appears.
    act(() => {
      getByTestId("pub-wh").click();
    });
    const node = await waitFor(() => getByRole("status"));
    expect(node.dataset.resourceKind).toBe("warehouse");
  });

  test("supports a full custom render override", async () => {
    function Trigger() {
      const { publish } = useResourceStatusPublisher("a", "x");
      return (
        <button
          type="button"
          data-testid="pub"
          onClick={() => {
            publish(
              makeStatus({
                kind: "warehouse",
                state: "STARTING",
                severity: "pending",
              }),
            );
          }}
        />
      );
    }

    const { getByTestId, findByTestId } = render(
      <ResourceStatusProvider>
        <Trigger />
        <ResourceStatusIndicator
          render={(agg) => (
            <span data-testid="custom">
              {agg.worst?.kind}:{agg.worst?.state}:{agg.activeCount}
            </span>
          )}
        />
      </ResourceStatusProvider>,
    );

    act(() => {
      getByTestId("pub").click();
    });
    const custom = await findByTestId("custom");
    expect(custom.textContent).toBe("warehouse:STARTING:1");
  });
});
