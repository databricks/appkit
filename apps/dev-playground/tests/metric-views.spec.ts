import { expect, type Page, type Route, test } from "@playwright/test";

const METRIC_ROUTE = "**/api/analytics/metric/revenue";

type MetricRequest = {
  measures: string[];
  dimensions?: string[];
  filter?: unknown;
  timeGrain?: string;
  timeDimension?: string;
  orderBy?: Array<{ field: string; direction: string }>;
  limit?: number;
};

const displayMetadata = {
  region: { type: "string", display_name: "Region" },
  segment: { type: "string", display_name: "Customer Segment" },
  created_at: { type: "timestamp_ltz", display_name: "Subscription Start" },
  arr: {
    type: "double",
    display_name: "Annual Recurring Revenue",
    format: "$#,##0.00",
  },
  mrr: {
    type: "double",
    display_name: "Monthly Recurring Revenue",
    format: "$#,##0.00",
  },
  new_arr: {
    type: "double",
    display_name: "New ARR",
    format: "$#,##0.00",
  },
  churned_arr: {
    type: "double",
    display_name: "Churned ARR",
    format: "$#,##0.00",
  },
} as const;

function baselineRows(body: MetricRequest): Array<Record<string, string>> {
  if (body.dimensions?.[0] === "segment") {
    return [
      { segment: "Enterprise", arr: "1493550348" },
      { segment: "Mid", arr: "105133668" },
      { segment: "SMB", arr: "6163392" },
    ];
  }

  if (body.dimensions?.[0] === "created_at") {
    return [
      { created_at: "2025-12-01T00:00:00.000Z", arr: "1200", mrr: "100" },
      { created_at: "2026-01-01T00:00:00.000Z", arr: "2400", mrr: "200" },
    ];
  }

  if (body.measures.length > 1) {
    return [
      {
        region: "AMER",
        arr: "849732624",
        mrr: "70811052",
        new_arr: "0",
        churned_arr: "0",
      },
      {
        region: "EMEA",
        arr: "521785968",
        mrr: "43482164",
        new_arr: "0",
        churned_arr: "0",
      },
      {
        region: "APAC",
        arr: "233328816",
        mrr: "19444068",
        new_arr: "0",
        churned_arr: "0",
      },
    ];
  }

  return [
    { region: "APAC", arr: "233328816" },
    { region: "EMEA", arr: "521785968" },
    { region: "AMER", arr: "849732624" },
  ];
}

function scopedMetadata(body: MetricRequest) {
  return Object.fromEntries(
    [...body.measures, ...(body.dimensions ?? [])].map((field) => [
      field,
      displayMetadata[field as keyof typeof displayMetadata],
    ]),
  );
}

async function fulfillMetric(
  route: Route,
  body: MetricRequest,
  rows = baselineRows(body),
) {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" },
    body: `event: result\ndata: ${JSON.stringify({
      type: "result",
      data: rows,
      metadata: scopedMetadata(body),
    })}\n\n`,
  });
}

async function selectFilter(
  page: Page,
  index: number,
  option: "AMER" | "APAC" | "EMEA" | "Enterprise" | "All regions",
) {
  await page.getByRole("combobox").nth(index).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("Metric Views playground", () => {
  test("loads once, shows four skeletons, and renders metadata-formatted baseline data", async ({
    page,
  }) => {
    const requests: MetricRequest[] = [];
    let releaseResponses: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponses = resolve;
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.route(METRIC_ROUTE, async (route) => {
      const body = route.request().postDataJSON() as MetricRequest;
      requests.push(body);
      await responseGate;
      await fulfillMetric(route, body);
    });

    await page.goto("/metric-views");
    await expect(
      page.getByRole("heading", { name: "Metric Views" }),
    ).toBeVisible();
    await expect.poll(() => requests.length).toBe(4);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(4);
    await expect(page.getByText("No results for this selection.")).toHaveCount(
      0,
    );

    releaseResponses?.();
    await expect(page.getByRole("button", { name: "AMER" })).toBeVisible();

    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.dimensions)).toEqual([
      ["region"],
      ["segment"],
      ["created_at"],
      ["region"],
    ]);
    await expect(page.getByRole("columnheader")).toHaveText([
      "Region",
      "Annual Recurring Revenue",
      "Monthly Recurring Revenue",
      "New ARR",
      "Churned ARR",
    ]);
    await expect(page.locator("tbody tr")).toHaveText([
      "AMER$849,732,624.00$70,811,052.00$0.00$0.00",
      "EMEA$521,785,968.00$43,482,164.00$0.00$0.00",
      "APAC$233,328,816.00$19,444,068.00$0.00$0.00",
    ]);
    await expect(
      page.getByRole("img", { name: "Annual recurring revenue by region" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: "Annual recurring revenue by customer segment",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: "Annual and monthly recurring revenue by month",
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("menuitem", { name: "Metric Views" }).click();
    await expect(page).toHaveURL(/\/metric-views$/);
    expect(consoleErrors).toEqual([]);
  });

  test("cross-filters with scoped predicates and supports keyboard/table clearing", async ({
    page,
  }) => {
    const requests: MetricRequest[] = [];
    await page.route(METRIC_ROUTE, async (route) => {
      const body = route.request().postDataJSON() as MetricRequest;
      requests.push(body);
      await fulfillMetric(route, body);
    });

    await page.goto("/metric-views");
    await expect(page.getByRole("button", { name: "AMER" })).toBeVisible();
    requests.length = 0;

    await page.getByRole("combobox").first().focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("option", { name: "AMER", exact: true })
      .press("Enter");
    await expect(
      page.getByRole("button", { name: "Remove Region filter" }),
    ).toContainText("Region: AMER");
    await expect.poll(() => requests.length).toBe(2);

    const segmentWithRegion = requests.find(
      (request) => request.dimensions?.[0] === "segment",
    );
    expect(segmentWithRegion?.filter).toEqual({
      member: "region",
      operator: "equals",
      values: ["AMER"],
    });
    await expect(page.locator("tbody tr")).toHaveCount(3);
    // Only the segment and trend cards apply the region predicate; the region
    // chart and table deliberately exclude their own facet.
    await expect(page.getByText("Region: AMER", { exact: true })).toHaveCount(
      2,
    );

    requests.length = 0;
    await page.getByRole("combobox").nth(1).focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("option", { name: "Enterprise", exact: true })
      .press("Space");
    await expect(
      page.getByRole("button", { name: "Remove Segment filter" }),
    ).toContainText("Segment: Enterprise");
    await expect.poll(() => requests.length).toBe(3);

    const regionRequest = requests.find(
      (request) =>
        request.dimensions?.[0] === "region" && request.measures.length === 1,
    );
    const tableRequest = requests.find(
      (request) => request.measures.length === 4,
    );
    const trendRequest = requests.find(
      (request) => request.dimensions?.[0] === "created_at",
    );
    const segmentPredicate = {
      member: "segment",
      operator: "equals",
      values: ["Enterprise"],
    };
    expect(regionRequest?.filter).toEqual(segmentPredicate);
    expect(tableRequest?.filter).toEqual(segmentPredicate);
    expect(trendRequest?.filter).toEqual({
      and: [
        { member: "region", operator: "equals", values: ["AMER"] },
        segmentPredicate,
      ],
    });

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(
      page.getByRole("button", { name: /Remove .* filter/ }),
    ).toHaveCount(0);

    const amer = page.getByRole("button", { name: "AMER" });
    await amer.click();
    await expect(amer).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Remove Region filter" }),
    ).toBeVisible();
    await amer.click();
    await expect(amer).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("button", { name: "Remove Region filter" }),
    ).toHaveCount(0);

    await amer.click();
    const regionChip = page.getByRole("button", {
      name: "Remove Region filter",
    });
    await regionChip.focus();
    await page.keyboard.press("Space");
    await expect(regionChip).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const regionBox = await page
      .getByRole("img", { name: "Annual recurring revenue by region" })
      .boundingBox();
    const segmentBox = await page
      .getByRole("img", {
        name: "Annual recurring revenue by customer segment",
      })
      .boundingBox();
    expect(regionBox).not.toBeNull();
    expect(segmentBox).not.toBeNull();
    expect(segmentBox?.y).toBeGreaterThan(
      (regionBox?.y ?? 0) + (regionBox?.height ?? 0),
    );
    const tableScrolls = await page
      .locator('[data-slot="table-container"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(tableScrolls).toBe(true);
  });

  test("chart clicks update the shared dropdowns and chips", async ({
    page,
  }) => {
    await page.route(METRIC_ROUTE, async (route) => {
      const body = route.request().postDataJSON() as MetricRequest;
      if (body.measures.length === 1 && body.dimensions?.[0] === "region") {
        await fulfillMetric(route, body, [
          { region: "APAC", arr: "100" },
          { region: "EMEA", arr: "100" },
          { region: "AMER", arr: "100" },
        ]);
        return;
      }
      if (body.dimensions?.[0] === "segment") {
        await fulfillMetric(route, body, [
          { segment: "Enterprise", arr: "100" },
          { segment: "Mid", arr: "100" },
          { segment: "SMB", arr: "100" },
        ]);
        return;
      }
      await fulfillMetric(route, body);
    });

    await page.goto("/metric-views");
    const regionChart = page.getByRole("img", {
      name: "Annual recurring revenue by region",
    });
    await expect(regionChart).toBeVisible();
    // ECharts animates bars/slices on mount; click after their hit regions are
    // at their final positions.
    await page.waitForTimeout(1_500);
    const regionCanvas = regionChart.locator("canvas");
    const regionBox = await regionCanvas.boundingBox();
    expect(regionBox).not.toBeNull();
    await regionCanvas.click({
      position: {
        x: (regionBox?.width ?? 0) * 0.25,
        y: (regionBox?.height ?? 0) * 0.78,
      },
    });
    await expect(page.getByRole("combobox").first()).toHaveText("APAC");
    await expect(
      page.getByRole("button", { name: "Remove Region filter" }),
    ).toContainText("Region: APAC");

    const segmentChart = page.getByRole("img", {
      name: "Annual recurring revenue by customer segment",
    });
    await page.waitForTimeout(1_000);
    const segmentCanvas = segmentChart.locator("canvas");
    const segmentBox = await segmentCanvas.boundingBox();
    expect(segmentBox).not.toBeNull();
    await segmentCanvas.click({
      position: {
        x: (segmentBox?.width ?? 0) * 0.41,
        y: (segmentBox?.height ?? 0) * 0.5,
      },
    });
    await expect(page.getByRole("combobox").nth(1)).toHaveText("SMB");
    await expect(
      page.getByRole("button", { name: "Remove Segment filter" }),
    ).toContainText("Segment: SMB");
  });

  test("keeps stale rows mounted and ignores late responses during rapid filters", async ({
    page,
  }) => {
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/analytics/metric/revenue")) {
        failedRequests.push(request.failure()?.errorText ?? "unknown");
      }
    });

    await page.route(METRIC_ROUTE, async (route) => {
      const body = route.request().postDataJSON() as MetricRequest;
      const filterText = JSON.stringify(body.filter ?? null);
      const delay = filterText.includes("AMER")
        ? 450
        : filterText.includes("APAC")
          ? 300
          : filterText.includes("EMEA")
            ? 50
            : 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const finalRows = filterText.includes("EMEA") ? [] : baselineRows(body);
      await fulfillMetric(route, body, finalRows);
    });

    await page.goto("/metric-views");
    await expect(page.getByRole("button", { name: "AMER" })).toBeVisible();

    await selectFilter(page, 0, "AMER");
    await expect(page.locator("tbody tr")).toHaveCount(3);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await selectFilter(page, 0, "APAC");
    await selectFilter(page, 0, "EMEA");

    await expect(page.getByRole("combobox").first()).toHaveText("EMEA");
    await expect(page.getByText("No results for this selection.")).toHaveCount(
      2,
    );
    await page.waitForTimeout(500);
    await expect(page.getByText("No results for this selection.")).toHaveCount(
      2,
    );
    expect(
      failedRequests.filter((error) => error === "net::ERR_ABORTED").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("renders empty and user-safe network error states", async ({ page }) => {
    let empty = true;
    let fail = false;
    await page.route(METRIC_ROUTE, async (route) => {
      if (fail) {
        await route.abort("failed");
        return;
      }
      const body = route.request().postDataJSON() as MetricRequest;
      await fulfillMetric(route, body, empty ? [] : baselineRows(body));
    });

    await page.goto("/metric-views");
    await expect(page.getByText("No results for this selection.")).toHaveCount(
      4,
    );

    empty = false;
    await page.reload();
    await expect(page.getByRole("button", { name: "AMER" })).toBeVisible();
    fail = true;
    await selectFilter(page, 0, "AMER");
    await expect(page.getByRole("alert").first()).toContainText(
      "Network error. Please check your connection.",
    );

    fail = false;
    await page.reload();
    await expect(page.getByRole("button", { name: "AMER" })).toBeVisible();
  });
});
