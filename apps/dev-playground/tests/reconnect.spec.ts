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

/**
 * RECONNECT-REPLAY scenario.
 *
 * The happy-path tests above mock `/api/reconnect/stream` (see
 * `setupMockAPI`), so they replay a static, all-at-once SSE body and never
 * touch the real server. That is why a `Last-Event-ID` replay regression in
 * the StreamManager ring buffer could (and did) go undetected for weeks: the
 * connection was never actually dropped mid-stream.
 *
 * These tests run against the REAL dev-playground server (no stream mock) and
 * force a mid-stream disconnect, asserting the client recovers ALL messages
 * with no duplicates and no gaps — i.e. the server replayed exactly the
 * buffered events the client missed.
 */
test.describe("Reconnect Route Tests - Last-Event-ID replay (recovery)", () => {
  // Reads the message-count headline ("N / 5 messages received").
  const readMessageCount = async (page: import("@playwright/test").Page) => {
    const container = page.locator("div").filter({
      has: page.getByText("/ 5 messages received"),
    });
    const text = await container.locator("h2").first().textContent();
    return Number.parseInt(text ?? "0", 10);
  };

  test("recovers all messages with no gaps or duplicates after a mid-stream network drop", async ({
    page,
    context,
  }) => {
    // Identify this as the reconnect-replay scenario for triage.
    test.info().annotations.push({
      type: "scenario",
      description: "reconnect-replay: mid-stream drop -> Last-Event-ID replay",
    });

    // NOTE: intentionally NOT calling setupMockAPI — we exercise the real
    // server SSE stream + StreamManager ring buffer.
    await page.goto("/reconnect", { waitUntil: "domcontentloaded" });

    const messageCount = page.locator("div").filter({
      has: page.getByText("/ 5 messages received"),
    });

    // Wait until SOME (not all) messages have arrived, then drop the network
    // mid-stream. The server yields 1 message every ~3s, so >=1 and <5 leaves
    // room to interrupt before completion.
    await expect
      .poll(() => readMessageCount(page), {
        timeout: 20000,
        message: "expected at least one message before forcing disconnect",
      })
      .toBeGreaterThanOrEqual(1);

    expect(await readMessageCount(page)).toBeLessThan(5);

    // Force a client-side disconnect mid-stream: this aborts the in-flight
    // fetch with a network error, triggering the hook's reconnect path which
    // re-requests the same streamId with a Last-Event-ID header.
    await context.setOffline(true);
    await page.waitForTimeout(1500);
    await context.setOffline(false);

    // After reconnection + replay, the stream must complete with all 5
    // messages. Web-first assertion polls until the headline reads "5".
    await expect(messageCount.locator("h2")).toHaveText("5", {
      timeout: 40000,
    });

    // Status should land on a terminal/healthy state, never "Error".
    await expect(
      page.locator('[data-slot="badge"]').filter({ hasText: "Error" }),
    ).toHaveCount(0);

    // Verify NO gaps and NO duplicates: the rendered stream must contain
    // exactly one "Message k/5" card for each k in 1..5. This is what proves
    // Last-Event-ID replay delivered the missed events without re-delivering
    // ones the client already had.
    for (let k = 1; k <= 5; k++) {
      await expect(
        page.getByText(`Message ${k}/5`, { exact: true }),
      ).toHaveCount(1, { timeout: 5000 });
    }
  });
});
