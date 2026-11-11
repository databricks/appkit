import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { CHART_MIN_HEIGHT, chartSizeStyle } from "../constants";
import { ChartWrapper } from "../wrapper";

afterEach(cleanup);

describe("chartSizeStyle", () => {
  test("fills the parent by default, never below the minimum", () => {
    expect(chartSizeStyle()).toEqual({
      height: "100%",
      minHeight: CHART_MIN_HEIGHT,
    });
  });

  test("an explicit height wins", () => {
    expect(chartSizeStyle(208)).toEqual({ height: 208 });
  });
});

describe("ChartWrapper sizing", () => {
  test("its box fills the parent by default", () => {
    render(
      <ChartWrapper data={[{ a: 1 }]} testId="w">
        {() => <span>chart</span>}
      </ChartWrapper>,
    );
    const box = screen.getByTestId("w");
    expect(box.style.height).toBe("100%");
    expect(box.style.minHeight).toBe(`${CHART_MIN_HEIGHT}px`);
  });

  test("and is exactly `height` tall when given", () => {
    render(
      <ChartWrapper data={[{ a: 1 }]} testId="w" height={208}>
        {() => <span>chart</span>}
      </ChartWrapper>,
    );
    const box = screen.getByTestId("w");
    expect(box.style.height).toBe("208px");
    expect(box.style.minHeight).toBe("");
  });
});
