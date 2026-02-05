import { expect, test } from "@playwright/test";
import {
  STRICT_MODE_MULTIPLIER,
  setupMockAPI,
  trackApiCalls,
  waitForPageLoad,
} from "./utils/test-utils";

test.describe("Data Visualization Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("data-visualization page loads successfully", async ({ page }) => {
    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    await expect(page).toHaveURL("/data-visualization");
  });

  test("page displays Data Visualization heading", async ({ page }) => {
    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    await expect(page.getByText("Data Visualization")).toBeVisible();
  });

  test("simple data table displays mock data", async ({ page }) => {
    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    // The simple table is the first table on the page
    const simpleTable = page.locator("table").nth(0);

    await simpleTable.scrollIntoViewIfNeeded();
    await expect(simpleTable).toBeVisible();

    // Verify the table contains expected mock data cells
    await expect(
      simpleTable.getByRole("cell", { name: "Untagged App 1" }),
    ).toBeVisible();
    await expect(
      simpleTable.getByRole("cell", { name: "user4@databricks.com" }),
    ).toBeVisible();
  });

  test("advanced data table displays mock data", async ({ page }) => {
    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    // The advanced table is the second table on the page
    const advancedTable = page.locator("table").nth(1);

    await advancedTable.scrollIntoViewIfNeeded();
    await expect(advancedTable).toBeVisible();

    // Verify the table contains expected mock data cells
    await expect(
      advancedTable.getByRole("cell", { name: "Untagged App 2" }),
    ).toBeVisible();
    await expect(
      advancedTable.getByRole("cell", { name: "user5@databricks.com" }),
    ).toBeVisible();
  });

  test("calls expected API endpoints on page load", async ({ page }) => {
    const untaggedAppsCalls = trackApiCalls(page, "untagged_apps");
    const spendDataCalls = trackApiCalls(page, "spend_data");
    const topContributorsCalls = trackApiCalls(page, "top_contributors");

    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    // Scroll to load all charts and tables
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState("networkidle");

    // Verify API calls: 2 tables use untagged_apps
    expect(untaggedAppsCalls.length).toBe(2 * STRICT_MODE_MULTIPLIER);
    // Multiple charts use spend_data (AreaChart x2, LineChart x2, RadarChart x2)
    expect(spendDataCalls.length).toBe(6 * STRICT_MODE_MULTIPLIER);
    // BarChart x2, PieChart x2 use top_contributors
    expect(topContributorsCalls.length).toBe(4 * STRICT_MODE_MULTIPLIER);
  });

  test("can toggle code visibility", async ({ page }) => {
    await page.goto("/data-visualization");
    await waitForPageLoad(page);

    const showCodeButton = page
      .getByRole("button", { name: "Show Code" })
      .first();
    await showCodeButton.click();

    // Verify code section is revealed by checking the Hide Code button appears
    await expect(
      page.getByRole("button", { name: "Hide Code" }).first(),
    ).toBeVisible();
  });
});
