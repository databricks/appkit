import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

interface TaskCase {
  description: string;
  action: "load" | "filter" | "api";
  filter?: string;
  endpoint?: string;
  expectedCount?: number;
  expectedIds?: string[];
  expectedFields?: string[];
  expectedBody?: Record<string, unknown>;
  expectedStatus?: number;
  expectedContentType?: string;
  expectedStatusText?: string;
  expectedColumns?: string[];
  expectedInStock?: string[];
  expectedOutOfStock?: string[];
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
const appUrl = process.env.APP_URL || "http://localhost:3000";

test.describe("product catalog — proto plugin scenario", () => {
  for (const c of cases) {
    test(`${c.action}: ${c.description}`, async ({ page, request }) => {
      switch (c.action) {
        case "load":
        case "filter": {
          await page.goto(appUrl);
          await page.waitForLoadState("networkidle");

          if (c.action === "filter" && c.filter && c.filter !== "all") {
            await page
              .getByRole("combobox", { name: "Category" })
              .selectOption(c.filter);
            await page.getByRole("button", { name: "Filter" }).click();
            await page.waitForLoadState("networkidle");
          }

          if (c.expectedCount !== undefined) {
            await expect(page.getByRole("status")).toHaveText(
              `Showing ${c.expectedCount} products`,
            );
          }

          if (c.expectedStatusText) {
            await expect(page.getByRole("status")).toHaveText(
              c.expectedStatusText,
            );
          }

          if (c.expectedIds) {
            const table = page.getByRole("table", { name: "Products" });
            for (const id of c.expectedIds) {
              await expect(table).toContainText(id);
            }
          }

          if (c.expectedColumns) {
            const table = page.getByRole("table", { name: "Products" });
            for (const col of c.expectedColumns) {
              await expect(
                table.getByRole("columnheader", { name: col, exact: true }),
              ).toBeVisible();
            }
          }

          if (c.expectedInStock) {
            const table = page.getByRole("table", { name: "Products" });
            for (const id of c.expectedInStock) {
              const row = table.getByRole("row").filter({ hasText: id });
              await expect(row).toContainText("Yes");
            }
          }

          if (c.expectedOutOfStock) {
            const table = page.getByRole("table", { name: "Products" });
            for (const id of c.expectedOutOfStock) {
              const row = table.getByRole("row").filter({ hasText: id });
              await expect(row).toContainText("No");
            }
          }
          break;
        }

        case "api": {
          const response = await request.get(`${appUrl}${c.endpoint}`);

          if (c.expectedStatus) {
            expect(response.status()).toBe(c.expectedStatus);
            return;
          }

          expect(response.ok()).toBeTruthy();

          if (c.expectedContentType) {
            expect(response.headers()["content-type"]).toContain(
              c.expectedContentType,
            );
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
