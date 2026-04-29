import { expect, test } from "@playwright/test";

/**
 * Phase 7 acceptance test for the `/metrics` demo route. Exercises the full
 * metric-view path through dev mode for one happy-path case (revenue, SP lane
 * with metadata flow) and one error case (customer_metrics, OBO lane returns
 * 404 because the demo workspace does not host the metric view).
 *
 * The mocks bypass the real SQL Warehouse so the test does not require live
 * Databricks credentials. SSE response envelopes match the existing analytics
 * route's shape (`{ type: "result", data }`).
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const REVENUE_ROWS = [
  { region: "EMEA", created_at: "2026-01-01T00:00:00Z", arr: 1_250_000 },
  { region: "EMEA", created_at: "2026-02-01T00:00:00Z", arr: 1_310_000 },
  { region: "APAC", created_at: "2026-01-01T00:00:00Z", arr: 720_000 },
  { region: "APAC", created_at: "2026-02-01T00:00:00Z", arr: 760_000 },
  { region: "AMER", created_at: "2026-01-01T00:00:00Z", arr: 2_400_000 },
  { region: "AMER", created_at: "2026-02-01T00:00:00Z", arr: 2_470_000 },
];

test.describe("Metric Views Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    // Happy-path mock: revenue (SP lane) returns six rows.
    await page.route("**/api/analytics/metric/revenue", async (route) => {
      // Best-effort: confirm the request body carries the expected
      // measures/dimensions/timeGrain/filter shape — the demo's call site is
      // contractual.
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({
        measures: ["arr"],
        dimensions: ["region", "created_at"],
        timeGrain: "month",
        filter: {
          member: "region",
          operator: "in",
          values: ["EMEA", "APAC", "AMER"],
        },
      });

      return route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: sseEvent({ type: "result", data: REVENUE_ROWS }),
      });
    });

    // Error-path mock: customer_metrics (OBO lane) returns a 404-shaped error
    // event. Mirrors the experience when the dev workspace does not host the
    // OBO metric view.
    await page.route(
      "**/api/analytics/metric/customer_metrics",
      async (route) => {
        return route.fulfill({
          status: 200,
          headers: SSE_HEADERS,
          body: sseEvent({
            type: "error",
            error: "Metric view not found",
            code: "METRIC_NOT_FOUND",
          }),
        });
      },
    );

    // /whoami stub — the OBO panel surfaces the user identity.
    await page.route("**/whoami", async (route) => {
      return route.fulfill({
        json: {
          xForwardedUser: "demo-user@databricks.com",
          adminUserId: null,
          isAdmin: false,
        },
      });
    });
  });

  test("metrics page loads and renders the route header", async ({ page }) => {
    await page.goto("/metrics", { waitUntil: "networkidle" });

    await expect(page).toHaveURL("/metrics");
    await expect(
      page.getByRole("heading", { name: "Metric Views" }),
    ).toBeVisible();
  });

  test("revenue chart renders with metadata-formatted axis", async ({
    page,
  }) => {
    await page.goto("/metrics", { waitUntil: "networkidle" });

    // Plotly renders an SVG inside `.js-plotly-plot`; its presence is the
    // load-bearing assertion that the metric query resolved + the metadata
    // flowed into the chart layout.
    const plotContainer = page.locator(".js-plotly-plot").first();
    await expect(plotContainer).toBeVisible({ timeout: 10000 });

    // The Y-axis title comes from `formatLabel("arr", metadata.measures.arr)`
    // — the metadata's `display_name` field. Two instances appear (chart title
    // + Y-axis title), so we assert at least one.
    await expect(
      page.getByText("Annual Recurring Revenue").first(),
    ).toBeVisible();
  });

  test("OBO panel shows the requesting user identity", async ({ page }) => {
    await page.goto("/metrics", { waitUntil: "networkidle" });

    // The /whoami response surfaces the mock user; the OBO panel exposes it.
    await expect(page.getByText("demo-user@databricks.com")).toBeVisible();
  });

  test("OBO error path renders the graceful fallback banner", async ({
    page,
  }) => {
    await page.goto("/metrics", { waitUntil: "networkidle" });

    // The error mock returns `code: "METRIC_NOT_FOUND"`. The route renders
    // a banner with the literal "Could not load customer metrics." message
    // when the OBO query fails — the v1 demo's expected fallback.
    await expect(
      page.getByText("Could not load customer metrics."),
    ).toBeVisible({ timeout: 10000 });
  });

  test("calls expected metric endpoints on page load", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/analytics/metric/")) {
        calls.push(request.url());
      }
    });

    await page.goto("/metrics", { waitUntil: "networkidle" });

    // React 19 Strict Mode doubles useEffect invocations in dev mode; assert
    // both routes fire (allowing for the multiplier).
    const revenueCalls = calls.filter((u) =>
      u.endsWith("/api/analytics/metric/revenue"),
    );
    const customerCalls = calls.filter((u) =>
      u.endsWith("/api/analytics/metric/customer_metrics"),
    );

    expect(revenueCalls.length).toBeGreaterThanOrEqual(1);
    expect(customerCalls.length).toBeGreaterThanOrEqual(1);
  });
});
