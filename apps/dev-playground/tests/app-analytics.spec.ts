import { expect, type Request, test } from "@playwright/test";

const RELAY_PATH = "/_analytics/v1/logs";
const TRACKED_EVENT_NAME = "playground_event_tracked";

interface OtlpLogsPayload {
  resourceLogs: Array<{
    scopeLogs: Array<{ logRecords: Array<{ eventName?: string }> }>;
  }>;
}

function isRelayPost(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === RELAY_PATH
  );
}

test.describe("App Analytics Route Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app-analytics", { waitUntil: "networkidle" });
  });

  test("app analytics page loads successfully", async ({ page }) => {
    await expect(page).toHaveURL("/app-analytics");
    await expect(
      page.getByRole("heading", { name: "App Analytics", exact: true }),
    ).toBeVisible();
  });

  test("Track then Flush posts OTLP JSON through the relay", async ({
    page,
  }) => {
    const relayRequest = page.waitForRequest(
      (request) =>
        isRelayPost(request) &&
        (request.postData() ?? "").includes(TRACKED_EVENT_NAME),
    );

    await page.getByRole("button", { name: "Track", exact: true }).click();
    await page.getByRole("button", { name: "Flush", exact: true }).click();

    const request = await relayRequest;
    expect(request.headers()["content-type"]).toContain("application/json");

    const payload = request.postDataJSON() as OtlpLogsPayload;
    const eventNames = payload.resourceLogs.flatMap(({ scopeLogs }) =>
      scopeLogs.flatMap(({ logRecords }) =>
        logRecords.map(({ eventName }) => eventName),
      ),
    );
    expect(eventNames).toContain(TRACKED_EVENT_NAME);

    // Without an OTLP endpoint the relay accepts and discards the records.
    const response = await request.response();
    expect(response?.status()).toBe(204);

    await expect(
      page.getByTestId("app-analytics-no-diagnostics"),
    ).toBeVisible();
  });
});
