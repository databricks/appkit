import { expect, test } from "@playwright/test";
import { setupMockAPI, waitForPageLoad } from "./fixtures/test-utils";

test.describe("Smoke Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("app loads and displays homepage", async ({ page }) => {
    await page.goto("/");
    await waitForPageLoad(page);

    await expect(
      page.getByRole("heading", { name: "AppKit Playground" }),
    ).toBeVisible();

    await expect(
      page.getByText("Explore the capabilities of the AppKit"),
    ).toBeVisible();
  });

  test("all feature cards are visible on homepage", async ({ page }) => {
    await page.goto("/");
    await waitForPageLoad(page);

    await expect(
      page.getByText("Analytics Dashboard", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Arrow Analytics Dashboard", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Stream Reconnection", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Data Visualization", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Telemetry", { exact: true })).toBeVisible();
    await expect(page.getByText("SQL Helpers", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Type-Safe SQL", { exact: true }),
    ).toBeVisible();
  });

  test("theme selector is visible on homepage", async ({ page }) => {
    await page.goto("/");
    await waitForPageLoad(page);

    const themeButton = page.locator('[class*="top-4"][class*="right-4"]');
    await expect(themeButton).toBeVisible();
  });

  test("no console errors on page load", async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/");
    await waitForPageLoad(page);

    expect(
      consoleErrors,
      `Console errors detected: ${consoleErrors.join(", ")}`,
    ).toHaveLength(0);
  });

  test("page has a title", async ({ page }) => {
    await page.goto("/");
    await waitForPageLoad(page);

    const title = await page.title();
    expect(title).toBeTruthy();
  });
});
