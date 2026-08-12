import { expect, test } from "@playwright/test";
import { setupMockAPI } from "./utils/test-utils";

const traceId = `trace:/main.agent_traces.appkit/${"b".repeat(32)}`;
const traceUrl = `https://example.cloud.databricks.com/ml/experiments/123456789/traces?selectedTraceId=${encodeURIComponent(traceId)}`;

test("smart-dashboard planner action produces one linked semantic trace", async ({
  page,
}) => {
  await setupMockAPI(page);
  await page.route("**/api/agents/chat", async (route) => {
    const body = [
      {
        type: "appkit.metadata",
        data: { threadId: "dashboard-1", traceId, traceUrl },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "filter_by_date_range",
          arguments: JSON.stringify({ start: "2016-11-01", end: "2016-11-30" }),
        },
      },
      {
        type: "response.output_text.delta",
        delta: "Applied the November filter.",
      },
      { type: "response.completed", response: {} },
    ]
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
  await expect(links).toHaveAttribute("href", traceUrl);
  await expect(page.getByText(traceId)).toBeVisible();
});
