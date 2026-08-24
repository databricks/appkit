import type { Page, Request } from "@playwright/test";
import { tableFromJSON, tableToIPC } from "apache-arrow";

import {
  mockAnalyticsData,
  mockReconnectMessages,
  mockTelemetryResponse,
} from "./mock-data";

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
 *
 * Mirrors a real Databricks warehouse: the Arrow schema is encoded
 * *positionally* (`col_0`, `col_1`, …) and the real names are returned
 * separately for the `X-Appkit-Arrow-Columns` header, so the client's relabel
 * path (positional schema → real names) is exercised end-to-end — that path
 * was the live bug and is otherwise only unit-tested.
 *
 * Array/object cells are stringified so Arrow can infer a primitive column
 * type, matching how the warehouse serializes complex types; chart-relevant
 * columns (names, numbers) are unaffected.
 */
function toArrowIPC(rows: readonly unknown[]): {
  body: Buffer;
  columnNames: string[];
} {
  const columnNames = Object.keys(rows[0] as Record<string, unknown>);
  const positional = rows.map((row) => {
    const values = Object.values(row as Record<string, unknown>);
    return Object.fromEntries(
      values.map((v, i) => [
        `col_${i}`,
        v !== null && typeof v === "object" ? JSON.stringify(v) : v,
      ]),
    );
  });
  return {
    body: Buffer.from(tableToIPC(tableFromJSON(positional), "stream")),
    columnNames,
  };
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
      const { body, columnNames } = toArrowIPC(data);
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apache.arrow.stream",
          "Cache-Control": "no-store",
          // Real warehouses encode the schema positionally (col_N) and send
          // the aliased names in this header; the client relabels the decoded
          // Table. Mirror that so the relabel path is covered.
          "X-Appkit-Arrow-Columns": encodeURIComponent(
            JSON.stringify(columnNames),
          ),
        },
        body,
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
