import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

interface SetupStep {
  method: string;
  endpoint: string;
  body: unknown;
  waitMs?: number;
}

interface TaskCase {
  description: string;
  action: "load" | "api";
  method?: string;
  url?: string;
  endpoint?: string;
  body?: unknown;
  setup?: SetupStep;
  expectedStatus?: number;
  expectedBody?: Record<string, unknown>;
  expectedFields?: string[];
  expectedTextContains?: string[];
}

interface CasesFile {
  cases: TaskCase[];
}

function resolveCasesPath(): string {
  const envPath = process.env.TASK_CASES_PATH;
  if (envPath)
    return path.isAbsolute(envPath)
      ? envPath
      : path.resolve(process.cwd(), envPath);
  return path.join(__dirname, "..", "public", "cases.json");
}

const casesFile: CasesFile = JSON.parse(
  fs.readFileSync(resolveCasesPath(), "utf8"),
);
const cases = casesFile.cases || [];
const appUrl = process.env.APP_URL || "http://localhost:3001";

test.describe("jobs plugin scenario", () => {
  for (const c of cases) {
    test(`${c.action}: ${c.description}`, async ({ page, request }) => {
      // Run setup step if present
      if (c.setup) {
        const setupResp = await request.fetch(`${appUrl}${c.setup.endpoint}`, {
          method: c.setup.method,
          data: c.setup.body,
          headers: { "Content-Type": "application/json" },
        });
        expect(setupResp.ok()).toBeTruthy();
        if (c.setup.waitMs) {
          await page.waitForTimeout(c.setup.waitMs);
        }
      }

      switch (c.action) {
        case "load": {
          const targetUrl = c.url ?? "/";
          await page.goto(`${appUrl}${targetUrl}`);
          await page.waitForLoadState("networkidle");

          if (c.expectedTextContains) {
            for (const text of c.expectedTextContains) {
              await expect(page.locator("body")).toContainText(text);
            }
          }
          break;
        }

        case "api": {
          const fetchOptions: Record<string, unknown> = {
            method: c.method ?? "GET",
          };
          if (c.body) {
            fetchOptions.data = c.body;
            fetchOptions.headers = { "Content-Type": "application/json" };
          }

          const response = await request.fetch(
            `${appUrl}${c.endpoint}`,
            fetchOptions,
          );

          if (c.expectedStatus) {
            expect(response.status()).toBe(c.expectedStatus);
            if (c.expectedStatus >= 400) return;
          }

          if (!c.expectedStatus) {
            expect(response.ok()).toBeTruthy();
          }

          if (c.expectedBody) {
            const body = await response.json();
            for (const [key, value] of Object.entries(c.expectedBody)) {
              expect(body[key]).toEqual(value);
            }
          }

          if (c.expectedFields) {
            const body = await response.json();
            for (const field of c.expectedFields) {
              expect(body).toHaveProperty(field);
            }
          }
          break;
        }
      }
    });
  }
});
