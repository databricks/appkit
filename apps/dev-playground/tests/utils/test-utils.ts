import type { Page, Request } from "@playwright/test";
import { tableFromJSON, tableToIPC } from "apache-arrow";
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

/** Maps a query URL to its mock rows (matched by query-key substring). */
const ANALYTICS_MOCK: Array<readonly [string, readonly unknown[]]> = [
  ["spend_summary", mockAnalyticsData.spendSummary],
  ["apps_list", mockAnalyticsData.appsList],
  ["untagged_apps", mockAnalyticsData.untaggedApps],
  ["spend_data", mockAnalyticsData.spendData],
  ["top_contributors", mockAnalyticsData.topContributors],
  ["app_activity_heatmap", mockAnalyticsData.appActivityHeatmap],
  ["sql_helpers_test", mockAnalyticsData.sqlHelpersTest],
];

function resolveAnalyticsMock(url: string): readonly unknown[] {
  return ANALYTICS_MOCK.find(([key]) => url.includes(key))?.[1] ?? [];
}

/**
 * Build raw Arrow IPC stream bytes from mock rows — the format `fetchArrowDirect`
 * expects for `format: "ARROW_STREAM"` (raw bytes on the response body, not SSE).
 * Array/object cells are stringified so Arrow can infer a primitive column type,
 * mirroring how the warehouse serializes complex types; chart-relevant columns
 * (names, numbers) are unaffected.
 */
function toArrowIPC(rows: readonly unknown[]): Buffer {
  const flat = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([k, v]) => [
        k,
        v !== null && typeof v === "object" ? JSON.stringify(v) : v,
      ]),
    ),
  );
  return Buffer.from(tableToIPC(tableFromJSON(flat), "stream"));
}

export async function setupMockAPI(page: Page) {
  await page.route("**/api/analytics/query/**", async (route) => {
    const data = resolveAnalyticsMock(route.request().url());

    // ARROW_STREAM requests read raw Arrow IPC bytes off the response body
    // (see fetchArrowDirect); everything else consumes the SSE/JSON result.
    let requestFormat: string | undefined;
    try {
      requestFormat = route.request().postDataJSON()?.format;
    } catch {
      // Non-JSON body (e.g. a GET) — treat as the SSE/JSON path.
    }

    if (requestFormat === "ARROW_STREAM" && data.length > 0) {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apache.arrow.stream",
          "Cache-Control": "no-store",
        },
        body: toArrowIPC(data),
      });
    }

    return route.fulfill({
      status: 200,
      headers: getSSEHeaders(),
      body: createSSEResponse(data),
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
