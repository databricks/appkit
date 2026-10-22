import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockUseAnalyticsQuery = vi.fn();

vi.mock("../../hooks/use-analytics-query", () => ({
  useAnalyticsQuery: (...args: unknown[]) => mockUseAnalyticsQuery(...args),
}));

import { TableWrapper } from "../table-wrapper";

const rows = Array.from({ length: 25 }, (_, i) => ({
  id: i,
  name: `row-${i}`,
}));

// Long enough for a microtask-driven render loop to rack up thousands of renders.
// Also lets TanStack arm its page-index auto-reset, which it only does in a
// microtask after the first row model is built.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("TableWrapper", () => {
  beforeEach(() => {
    mockUseAnalyticsQuery.mockReturnValue({
      data: rows,
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("does not loop when the parent re-renders with a stable transformer", async () => {
    const transformer = vi.fn((data: typeof rows) =>
      data.map((row) => ({ ...row })),
    );
    let renders = 0;
    const children = (table: any) => {
      renders++;
      return <span>{table.getRowModel().rows.length}</span>;
    };

    const { rerender } = render(
      <TableWrapper queryKey="q" parameters={{}} transformer={transformer}>
        {children}
      </TableWrapper>,
    );
    await settle();
    rerender(
      <TableWrapper queryKey="q" parameters={{}} transformer={transformer}>
        {children}
      </TableWrapper>,
    );
    await settle();

    expect(transformer).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThanOrEqual(3);
  });

  test("settles after each parent re-render with an inline transformer", async () => {
    let renders = 0;
    const renderTable = () => (
      <TableWrapper
        queryKey="q"
        parameters={{}}
        transformer={(data: typeof rows) => data.map((row) => ({ ...row }))}
      >
        {(table) => {
          renders++;
          return <span>{table.getRowModel().rows.length}</span>;
        }}
      </TableWrapper>
    );

    const { rerender } = render(renderTable());
    await settle();
    rerender(renderTable());
    await settle();
    rerender(renderTable());
    await settle();

    expect(renders).toBeLessThanOrEqual(6);
  });

  test("keeps the current page when the parent re-renders", async () => {
    const transformer = (data: typeof rows) => data.map((row) => ({ ...row }));
    let pageIndex = -1;
    let goToNextPage = () => {};
    const children = (table: any) => {
      pageIndex = table.getState().pagination.pageIndex;
      goToNextPage = () => table.nextPage();
      return <span>{table.getRowModel().rows.length}</span>;
    };

    const { rerender } = render(
      <TableWrapper queryKey="q" parameters={{}} transformer={transformer}>
        {children}
      </TableWrapper>,
    );
    await settle();
    goToNextPage();
    await settle();
    expect(pageIndex).toBe(1);

    rerender(
      <TableWrapper queryKey="q" parameters={{}} transformer={transformer}>
        {children}
      </TableWrapper>,
    );
    await settle();

    expect(pageIndex).toBe(1);
  });
});
