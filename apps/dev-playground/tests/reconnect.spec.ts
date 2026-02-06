import { expect, test } from "@playwright/test";
import { setupMockAPI } from "./utils/test-utils";

test.describe("Reconnect Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("reconnect page loads successfully", async ({ page }) => {
    await page.goto("/reconnect", { waitUntil: "networkidle" });

    await expect(page).toHaveURL("/reconnect");
  });

  test("connects to SSE stream and receives all messages", async ({ page }) => {
    const streamRequestPromise = page.waitForRequest((request) =>
      request.url().includes("/api/reconnect/stream"),
    );

    await page.goto("/reconnect", { waitUntil: "networkidle" });
    await streamRequestPromise;

    await expect(
      page.locator('[data-slot="badge"]').filter({ hasText: "Reconnected" }),
    ).toBeVisible({ timeout: 5000 });

    const messageCountContainer = page.locator("div").filter({
      has: page.getByText("/ 5 messages received"),
    });
    await expect(messageCountContainer.locator("h2")).toHaveText("5", {
      timeout: 5000,
    });
  });

  test("restart button triggers new stream connection", async ({ page }) => {
    await page.goto("/reconnect", { waitUntil: "networkidle" });

    const newStreamRequestPromise = page.waitForRequest((request) =>
      request.url().includes("/api/reconnect/stream"),
    );

    const restartButton = page.getByRole("button", { name: /restart/i });
    await restartButton.click();

    await newStreamRequestPromise;
  });
});
