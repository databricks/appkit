import { expect, test } from "@playwright/test";
import { runSmartDashboardTracingFixture } from "../server/tests/smart-dashboard-agent-tracing.fixture";
import { setupMockAPI } from "./utils/test-utils";

test("smart-dashboard planner action produces one linked semantic trace", async ({
  page,
}) => {
  const observed = await runSmartDashboardTracingFixture({
    includeTraceUrl: true,
  });
  const traceUrl = observed.events[0].data?.traceUrl;
  await setupMockAPI(page);
  await page.route("**/api/agents/chat", async (route) => {
    const body = observed.events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body,
    });
  });

  await page.goto("/smart-dashboard");
  await page.getByRole("button", { name: "Toggle chat (⌘J)" }).click();
  await page.getByPlaceholder("Ask the dashboard…").fill("Show November 2016");
  await page.getByPlaceholder("Ask the dashboard…").press("Enter");

  await expect(page.getByText("Applied the November filter.")).toBeVisible();
  const links = page.getByRole("link", { name: "Open trace in MLflow" });
  await expect(links).toHaveCount(1);
  expect(traceUrl).toBeDefined();
  await expect(links).toHaveAttribute("href", traceUrl as string);
  await expect(page.getByText(observed.traceId)).toBeVisible();
});

test("smart-dashboard surfaces its trace ID without a workspace link", async ({
  page,
}) => {
  const observed = await runSmartDashboardTracingFixture();
  await setupMockAPI(page);
  await page.route("**/api/agents/chat", async (route) => {
    const body = observed.events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body,
    });
  });

  await page.goto("/smart-dashboard");
  await page.getByRole("button", { name: "Toggle chat (⌘J)" }).click();
  await page.getByPlaceholder("Ask the dashboard…").fill("Trace without a URL");
  await page.getByPlaceholder("Ask the dashboard…").press("Enter");

  await expect(page.getByText(observed.traceId)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open trace in MLflow" }),
  ).toHaveCount(0);
});
