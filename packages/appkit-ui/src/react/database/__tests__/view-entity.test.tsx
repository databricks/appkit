import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DatabaseEntityKey } from "@/js";
import { ViewEntity } from "../view-entity";

function mockFetch(rows: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(rows)),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CASES: DatabaseEntityKey = "cases";

describe("<ViewEntity>", () => {
  test("renders a table with one row per fetched entry and auto-derives headers from data keys", async () => {
    mockFetch([
      { case_id: "CASE-1", status: "New", risk_score: 42 },
      { case_id: "CASE-2", status: "Pending", risk_score: null },
    ]);

    render(<ViewEntity entity={CASES} />);

    await waitFor(() => {
      expect(screen.getByText("CASE-1")).toBeDefined();
    });
    expect(screen.getByText("Case Id")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Risk Score")).toBeDefined();
    expect(screen.getByText("CASE-2")).toBeDefined();
  });

  test("renders an empty state when the server returns no rows", async () => {
    mockFetch([]);
    render(<ViewEntity entity={CASES} />);
    await waitFor(() => {
      expect(screen.getByText(/No rows to display/i)).toBeDefined();
    });
  });

  test("honors `fields` allow-list for rendered columns", async () => {
    mockFetch([{ case_id: "CASE-1", status: "New", risk_score: 1 }]);

    render(<ViewEntity entity={CASES} fields={["case_id", "status"]} />);

    await waitFor(() => {
      expect(screen.getByText("CASE-1")).toBeDefined();
    });
    expect(screen.queryByText("Risk Score")).toBeNull();
  });
});
