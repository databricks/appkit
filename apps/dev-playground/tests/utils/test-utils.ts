import type { Page, Request } from "@playwright/test";
import {
  mockAnalyticsData,
  mockReconnectMessages,
  mockTelemetryResponse,
} from "./mock-data";

/**
 * React 19 Strict Mode doubles useEffect invocations in development mode
 * to help detect side effects. This multiplier accounts for that behavior
 * when asserting API call counts in tests.
 *
 * @see https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development
 */
export const STRICT_MODE_MULTIPLIER = 2;

function createSSEResponse(data: unknown): string {
  const event = JSON.stringify({ type: "result", data });
  return `data: ${event}\n\n`;
}

function getSSEHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

export async function setupMockAPI(page: Page) {
  await page.route("**/api/analytics/query/**", async (route) => {
    const url = route.request().url();

    if (url.includes("spend_summary")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.spendSummary),
      });
    }
    if (url.includes("apps_list")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.appsList),
      });
    }
    if (url.includes("untagged_apps")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.untaggedApps),
      });
    }
    if (url.includes("spend_data")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.spendData),
      });
    }
    if (url.includes("top_contributors")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.topContributors),
      });
    }
    if (url.includes("app_activity_heatmap")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.appActivityHeatmap),
      });
    }
    if (url.includes("sql_helpers_test")) {
      return route.fulfill({
        status: 200,
        headers: getSSEHeaders(),
        body: createSSEResponse(mockAnalyticsData.sqlHelpersTest),
      });
    }

    // Default empty response for unknown queries
    return route.fulfill({
      status: 200,
      headers: getSSEHeaders(),
      body: createSSEResponse([]),
    });
  });

  await page.route("**/api/reconnect/stream**", async (route) => {
    const body = mockReconnectMessages
      .map((msg, i) => `id: ${i + 1}\ndata: ${JSON.stringify(msg)}\n\n`)
      .join("");

    return route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body,
    });
  });

  await page.route("**/api/reconnect", async (route) => {
    if (route.request().url().endsWith("/api/reconnect")) {
      return route.fulfill({ json: { message: "Reconnected" } });
    }
    return route.continue();
  });

  await page.route("**/api/telemetry-examples/**", async (route) => {
    return route.fulfill({ json: mockTelemetryResponse });
  });
}

export async function waitForChartsToLoad(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => document.querySelectorAll(".animate-pulse").length === 0,
    { timeout: 10000 },
  );
}

export function trackApiCalls(page: Page, urlPattern: string) {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes(urlPattern)) {
      requests.push(request);
    }
  });
  return requests;
}
