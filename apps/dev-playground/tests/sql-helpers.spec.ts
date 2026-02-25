import { expect, test } from "@playwright/test";
import { mockAnalyticsData } from "./utils/mock-data";
import { setupMockAPI } from "./utils/test-utils";

test.describe("SQL Helpers Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
    await page.goto("/sql-helpers", { waitUntil: "networkidle" });
  });

  test("sql-helpers page loads successfully", async ({ page }) => {
    await expect(page).toHaveURL("/sql-helpers");
  });

  test("can interact with string input", async ({ page }) => {
    const inputs = page.locator("input").first();
    await inputs.fill("Test String Value");

    await expect(inputs).toHaveValue("Test String Value");
  });

  test("can interact with number input", async ({ page }) => {
    const numberInput = page.locator('input[type="number"]').first();
    await numberInput.fill("123");

    await expect(numberInput).toHaveValue("123");
  });

  test("can toggle boolean value", async ({ page }) => {
    const falseButton = page.getByRole("button", { name: "false" });
    await falseButton.click();

    const trueButton = page.getByRole("button", { name: "true" });
    await expect(trueButton).toBeVisible();
  });

  test("show code button reveals code example", async ({ page }) => {
    const showCodeButton = page
      .getByRole("button", { name: "Show Code" })
      .first();
    await showCodeButton.click();

    await expect(page.getByText("Usage:").first()).toBeVisible();
  });

  test("sql_helpers_test query executes and displays mock data", async ({
    page,
  }) => {
    await expect(page.getByText("Query executed successfully")).toBeVisible({
      timeout: 5000,
    });

    const resultPre = page.locator(".bg-success\\/10 pre");
    await expect(resultPre).toBeVisible();
    await expect(resultPre).toHaveText(
      JSON.stringify(mockAnalyticsData.sqlHelpersTest[0], null, 2),
    );
  });
});
