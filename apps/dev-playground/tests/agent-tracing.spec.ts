import { expect, test } from "@playwright/test";

const traceId = `trace:/main.agent_traces.appkit/${"a".repeat(32)}`;
const traceUrl = `https://example.cloud.databricks.com/ml/experiments/123456789/traces?selectedTraceId=${encodeURIComponent(traceId)}`;

test("agent invocation surfaces its V4 trace identity and direct MLflow link", async ({
  page,
}) => {
  await page.route("**/api/agents/chat", async (route) => {
    const body = [
      {
        type: "appkit.metadata",
        data: { threadId: "thread-1", traceId, traceUrl },
      },
      { type: "response.output_text.delta", delta: "Traced answer" },
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

  await page.goto("/agent");
  await page.getByPlaceholder("Ask a question...").fill("Trace this request");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByRole("paragraph").filter({ hasText: "Traced answer" }),
  ).toBeVisible();
  await expect(page.getByText(traceId)).toBeVisible();
  const link = page.getByRole("link", { name: "Open trace in MLflow" });
  await expect(link).toHaveAttribute("href", traceUrl);
});
