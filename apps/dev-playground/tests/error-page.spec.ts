import { expect, test } from "@playwright/test";

import { setupMockAPI } from "./utils/test-utils";

test.describe("Error Page Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
    await page.goto("/error-page", { waitUntil: "networkidle" });
  });

  test("a route that throws shows AppKit's error page inside the layout", async ({
    page,
  }) => {
    await expect(page.getByText("Something went wrong")).toBeVisible();
    await expect(page.getByText("Unexpected Application Error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to home" }),
    ).toHaveAttribute("href", "/");
    await expect(
      page.getByRole("heading", { name: "AppKit Playground" }),
    ).toBeVisible();
  });

  test("shows the thrown error's message in development", async ({ page }) => {
    // The suite runs against `pnpm dev`: details show only in development.
    await expect(
      page.getByText("This route throws on purpose", { exact: false }),
    ).toBeVisible();
  });
});
