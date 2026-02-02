import { expect, test } from "@playwright/test";
import {
  setupMockAPI,
  trackApiCalls,
  waitForPageLoad,
} from "./fixtures/test-utils";

test.describe("Telemetry Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  test("telemetry page loads successfully", async ({ page }) => {
    await page.goto("/telemetry");
    await waitForPageLoad(page);

    await expect(page).toHaveURL("/telemetry");
  });

  test("run button triggers POST request and shows success", async ({
    page,
  }) => {
    const requests = trackApiCalls(page, "/api/telemetry-examples");

    await page.goto("/telemetry");
    await waitForPageLoad(page);

    const runButton = page.getByRole("button", { name: /Run.*Request/i });
    await runButton.click();

    await expect(page.getByText("Success")).toBeVisible({ timeout: 5000 });

    const postRequests = requests.filter((r) => r.method() === "POST");
    expect(postRequests.length).toBeGreaterThan(0);
  });
});
