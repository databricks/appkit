import { expect, test } from "@playwright/test";
import {
  STRICT_MODE_MULTIPLIER,
  setupMockAPI,
  trackApiCalls,
  waitForChartsToLoad,
} from "./utils/test-utils";

test.describe("Arrow Analytics", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("page loads and displays heading", async ({ page }) => {
    await page.goto("/arrow-analytics", { waitUntil: "networkidle" });

    await expect(page.getByText("Unified Charts API")).toBeVisible();
  });

  test("calls expected API endpoints", async ({ page }) => {
    const appsListCalls = trackApiCalls(page, "apps_list");
    const spendDataCalls = trackApiCalls(page, "spend_data");
    const topContributorsCalls = trackApiCalls(page, "top_contributors");
    const heatmapCalls = trackApiCalls(page, "app_activity_heatmap");

    await page.goto("/arrow-analytics", { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await waitForChartsToLoad(page);

    expect(appsListCalls.length).toBe(5 * STRICT_MODE_MULTIPLIER);
    expect(spendDataCalls.length).toBe(5 * STRICT_MODE_MULTIPLIER);
    expect(topContributorsCalls.length).toBe(2 * STRICT_MODE_MULTIPLIER);
    expect(heatmapCalls.length).toBe(2 * STRICT_MODE_MULTIPLIER);
  });

  test("charts render with mock data (no empty states)", async ({ page }) => {
    await page.goto("/arrow-analytics", { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await waitForChartsToLoad(page);

    const barCharts = page.locator('[data-testid="bar-chart-apps_list"]');
    expect(await barCharts.count()).toBe(3);
    await expect(barCharts.first().locator("canvas")).toBeVisible();

    const lineCharts = page.locator('[data-testid="line-chart-spend_data"]');
    expect(await lineCharts.count()).toBe(3);
    await expect(lineCharts.first().locator("canvas")).toBeVisible();

    const donutCharts = page.locator(
      '[data-testid="donut-chart-top_contributors"]',
    );
    expect(await donutCharts.count()).toBe(2);
    await expect(donutCharts.first().locator("canvas")).toBeVisible();

    const heatmapCharts = page.locator(
      '[data-testid="heatmap-chart-app_activity_heatmap"]',
    );
    expect(await heatmapCharts.count()).toBe(2);
    await expect(heatmapCharts.first().locator("canvas")).toBeVisible();
  });

  test("chart tooltip appears on hover with mock app data", async ({
    page,
  }) => {
    await page.goto("/arrow-analytics", { waitUntil: "networkidle" });
    await waitForChartsToLoad(page);

    const barChart = page
      .locator('[data-testid="bar-chart-apps_list"]')
      .first()
      .locator("canvas");
    await expect(barChart).toBeVisible();

    const box = await barChart.boundingBox();
    if (!box) throw new Error("Could not get chart bounding box");

    const positions = [0.2, 0.35, 0.5, 0.65, 0.8];
    for (const xRatio of positions) {
      await page.mouse.move(
        box.x + box.width * xRatio,
        box.y + box.height * 0.4,
      );

      const tooltip = page
        .locator("div")
        .filter({ hasText: /App One|App Two|App Three/ });

      try {
        await expect(tooltip.first()).toBeVisible({ timeout: 1000 });
        return;
      } catch {}
    }

    throw new Error(
      "Could not trigger tooltip with any mock app data after trying multiple positions",
    );
  });
});
