import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../charts/base", () => ({
  BaseChart: () => <div data-testid="inferred-chart" />,
}));

import { GenieQueryVisualization } from "../genie-query-visualization";
import type { GenieStatementResponse } from "../types";

const data: GenieStatementResponse = {
  manifest: {
    schema: {
      columns: [
        { name: "country", typeName: "STRING" },
        { name: "franchises", typeName: "INT" },
      ],
    },
  },
  result: {
    dataArray: [
      ["Japan", "20"],
      ["US", "16"],
    ],
  },
};

describe("GenieQueryVisualization", () => {
  afterEach(cleanup);

  test("shows the chart image in the Chart tab and keeps the Table tab", () => {
    render(
      <GenieQueryVisualization
        data={data}
        chartImageUrl="/viz.png"
        chartImageAlt="Franchises by Country"
      />,
    );

    const img = screen.getByRole("img", { name: "Franchises by Country" });
    expect(img.getAttribute("src")).toBe("/viz.png");
    expect(screen.queryByTestId("inferred-chart")).toBeNull();
    expect(screen.getByRole("tab", { name: "Table" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Japan" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Change chart type" }),
    ).toBeNull();
  });

  test("falls back to the inferred chart when the image fails to load", () => {
    render(<GenieQueryVisualization data={data} chartImageUrl="/viz.png" />);

    fireEvent.error(screen.getByRole("img"));

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("inferred-chart")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Japan" })).toBeTruthy();
  });

  test("shows the inferred chart without a chart image", () => {
    render(<GenieQueryVisualization data={data} />);

    expect(screen.getByTestId("inferred-chart")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
