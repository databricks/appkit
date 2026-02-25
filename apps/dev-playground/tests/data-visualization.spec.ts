import { expect, test } from "@playwright/test";
import {
  STRICT_MODE_MULTIPLIER,
  setupMockAPI,
  trackApiCalls,
} from "./utils/test-utils";

test.describe("Data Visualization Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("data-visualization page loads successfully", async ({ page }) => {
    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    await expect(page).toHaveURL("/data-visualization");
  });

  test("page displays Data Visualization heading", async ({ page }) => {
    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    await expect(page.getByText("Data Visualization")).toBeVisible();
  });

  test("simple data table displays mock data", async ({ page }) => {
    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    const simpleTable = page.locator("table").nth(0);

    await simpleTable.scrollIntoViewIfNeeded();
    await expect(simpleTable).toBeVisible();

    await expect(
      simpleTable.getByRole("cell", { name: "Untagged App 1" }),
    ).toBeVisible();
    await expect(
      simpleTable.getByRole("cell", { name: "user4@databricks.com" }),
    ).toBeVisible();
  });

  test("advanced data table displays mock data", async ({ page }) => {
    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    const advancedTable = page.locator("table").nth(1);

    await advancedTable.scrollIntoViewIfNeeded();
    await expect(advancedTable).toBeVisible();

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

    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState("networkidle");

    expect(untaggedAppsCalls.length).toBe(2 * STRICT_MODE_MULTIPLIER);
    expect(spendDataCalls.length).toBe(6 * STRICT_MODE_MULTIPLIER);
    expect(topContributorsCalls.length).toBe(4 * STRICT_MODE_MULTIPLIER);
  });

  test("can toggle code visibility", async ({ page }) => {
    await page.goto("/data-visualization", { waitUntil: "networkidle" });

    const showCodeButton = page
      .getByRole("button", { name: "Show Code" })
      .first();
    await showCodeButton.click();

    await expect(
      page.getByRole("button", { name: "Hide Code" }).first(),
    ).toBeVisible();
  });
});
