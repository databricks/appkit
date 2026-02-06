import { expect, test } from "@playwright/test";
import { setupMockAPI, trackApiCalls } from "./utils/test-utils";

test.describe("Telemetry Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
    await page.goto("/telemetry", { waitUntil: "networkidle" });
  });

  test("telemetry page loads successfully", async ({ page }) => {
    await expect(page).toHaveURL("/telemetry");
  });

  test("run button triggers POST request and shows success", async ({
    page,
  }) => {
    const requests = trackApiCalls(page, "/api/telemetry-examples");

    const runButton = page.getByRole("button", { name: /Run.*Request/i });
    await runButton.click();

    await expect(page.getByText("Success")).toBeVisible({ timeout: 5000 });

    const postRequests = requests.filter((r) => r.method() === "POST");
    expect(postRequests.length).toBeGreaterThan(0);
  });
});
