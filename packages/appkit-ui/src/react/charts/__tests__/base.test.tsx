/**
 * Mount tests for BaseChart with the modular ECharts build.
 *
 * `base.tsx` imports from `echarts/core` and registers only the chart types,
 * components, and renderer that the option builders use. ECharts does NOT
 * throw when a series type or component is missing from the registration —
 * it logs an error like "Series heatmap is used but not imported" and renders
 * nothing. These tests mount every chart family and assert no such error is
 * emitted, so a missing registration fails the suite instead of silently
 * producing blank charts.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import * as echarts from "echarts/core";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { BaseChart } from "../base";
import type { ChartType } from "../types";

// ----------------------------------------------------------------------------
// jsdom canvas stub: ECharts' CanvasRenderer needs a 2D context, which jsdom
// does not implement. A Proxy that no-ops every method (and returns a metrics
// object for measureText) is enough for ECharts to lay out and "paint".
// ----------------------------------------------------------------------------
beforeAll(() => {
  // jsdom doesn't implement window.matchMedia, which the chart theme hook
  // reads to track color-scheme changes.
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

  const contextStub = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, prop: string) {
        if (prop === "measureText") {
          return () => ({ width: 10 });
        }
        if (
          prop === "createLinearGradient" ||
          prop === "createRadialGradient"
        ) {
          return () => ({ addColorStop: () => {} });
        }
        if (!(prop in target)) {
          target[prop] = vi.fn();
        }
        return target[prop];
      },
      set() {
        return true;
      },
    },
  );

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    writable: true,
    value: () => contextStub,
  });
});

const registrationErrors: string[] = [];

function captureRegistrationIssues(...args: unknown[]) {
  const message = args.map(String).join(" ");
  // Matches ECharts messages such as:
  //   "Series heatmap is used but not imported."
  //   "Component visualMap is used but not imported."
  //   "Renderer 'canvas' is not imported."
  //   "Specified `grid.containLabel` but no `use(LegacyGridContainLabel)`"
  if (/not (imported|exists|registered)|no `?use\(/i.test(message)) {
    registrationErrors.push(message);
  }
}

beforeEach(() => {
  registrationErrors.length = 0;
  vi.spyOn(console, "error").mockImplementation(captureRegistrationIssues);
  vi.spyOn(console, "warn").mockImplementation(captureRegistrationIssues);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cartesianData = [
  { month: "Jan", revenue: 100, cost: 60 },
  { month: "Feb", revenue: 120, cost: 70 },
  { month: "Mar", revenue: 90, cost: 50 },
];

const heatmapData = [
  { day: "Mon", hour: "9am", value: 3 },
  { day: "Mon", hour: "10am", value: 7 },
  { day: "Tue", hour: "9am", value: 5 },
  { day: "Tue", hour: "10am", value: 1 },
];

describe("BaseChart ECharts registration", () => {
  const cartesianTypes: ChartType[] = ["line", "area", "bar", "scatter"];

  test.each(cartesianTypes)(
    "renders %s chart without missing-registration errors",
    async (chartType) => {
      const { container } = render(
        <BaseChart
          data={cartesianData}
          chartType={chartType}
          xKey="month"
          yKey={["revenue", "cost"]}
          title="Test"
        />,
      );

      await waitFor(() =>
        expect(container.querySelector("canvas")).not.toBeNull(),
      );
      expect(registrationErrors).toEqual([]);
    },
  );

  test("renders horizontal bar chart without missing-registration errors", async () => {
    const { container } = render(
      <BaseChart
        data={cartesianData}
        chartType="bar"
        xKey="month"
        yKey="revenue"
        orientation="horizontal"
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("canvas")).not.toBeNull(),
    );
    expect(registrationErrors).toEqual([]);
  });

  test.each(["pie", "donut"] as ChartType[])(
    "renders %s chart without missing-registration errors",
    async (chartType) => {
      const { container } = render(
        <BaseChart
          data={cartesianData}
          chartType={chartType}
          xKey="month"
          yKey="revenue"
        />,
      );

      await waitFor(() =>
        expect(container.querySelector("canvas")).not.toBeNull(),
      );
      expect(registrationErrors).toEqual([]);
    },
  );

  test("renders radar chart without missing-registration errors", async () => {
    const { container } = render(
      <BaseChart
        data={cartesianData}
        chartType="radar"
        xKey="month"
        yKey={["revenue", "cost"]}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("canvas")).not.toBeNull(),
    );
    expect(registrationErrors).toEqual([]);
  });

  test("renders heatmap (visualMap component) without missing-registration errors", async () => {
    const { container } = render(
      <BaseChart
        data={heatmapData}
        chartType="heatmap"
        xKey="day"
        yAxisKey="hour"
        yKey="value"
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("canvas")).not.toBeNull(),
    );
    expect(registrationErrors).toEqual([]);
  });

  test("renders custom `options` using a registered component without registration errors", async () => {
    const { container } = render(
      <BaseChart
        data={cartesianData}
        chartType="line"
        xKey="month"
        yKey="revenue"
        options={{ title: { subtext: "custom" } }}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("canvas")).not.toBeNull(),
    );
    expect(registrationErrors).toEqual([]);
  });

  test("passes the chart instance when normalizing a line stroke click", async () => {
    const onDataClick = vi.fn();
    const { container } = render(
      <BaseChart
        data={cartesianData}
        chartType="line"
        xKey="month"
        yKey="revenue"
        onDataClick={onDataClick}
      />,
    );

    const chartElement = await waitFor(() => {
      const element =
        container.querySelector<HTMLElement>(".echarts-for-react");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    type TestChartInstance = {
      convertToPixel(
        finder: { seriesIndex: number },
        value: (string | number)[],
      ): unknown;
      isSilent(eventName: string): boolean;
      trigger(eventName: string, params: unknown): void;
    };
    const instance = await waitFor(() => {
      const current = echarts.getInstanceByDom(chartElement) as
        | (ReturnType<typeof echarts.getInstanceByDom> & TestChartInstance)
        | undefined;
      expect(current).toBeDefined();
      expect(current?.isSilent("click")).toBe(false);
      return current as TestChartInstance;
    });

    instance.convertToPixel = vi.fn((_finder, point) => [
      cartesianData.findIndex((row) => row.month === point[0]) * 100,
      point[1],
    ]);

    instance.trigger("click", {
      seriesType: "line",
      seriesName: "Revenue",
      seriesIndex: 0,
      event: { offsetX: 185, offsetY: 90 },
    });

    expect(onDataClick).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Mar",
        value: 90,
        x: "Mar",
        y: 90,
        dataIndex: 2,
        seriesIndex: 0,
      }),
    );
  });

  test("renders the no-data fallback for empty data without mounting ECharts", () => {
    const { container, getByText } = render(
      <BaseChart data={[]} chartType="line" />,
    );

    expect(getByText("No data")).toBeTruthy();
    expect(container.querySelector("canvas")).toBeNull();
    expect(registrationErrors).toEqual([]);
  });
});
