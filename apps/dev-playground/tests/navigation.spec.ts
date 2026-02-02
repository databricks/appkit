import { expect, test } from "@playwright/test";
import { setupMockAPI, waitForPageLoad } from "./fixtures/test-utils";

const homepageNavigationTests: Array<{
  name: string;
  buttonName: string;
  buttonIndex?: number;
  expectedUrl: string;
}> = [
  {
    name: "analytics",
    buttonName: "Explore real-time analytics",
    buttonIndex: 0,
    expectedUrl: "/analytics",
  },
  {
    name: "arrow-analytics",
    buttonName: "Explore real-time analytics",
    buttonIndex: 1,
    expectedUrl: "/arrow-analytics",
  },
  {
    name: "reconnect",
    buttonName: "View Reconnect Demo",
    expectedUrl: "/reconnect",
  },
  {
    name: "data-visualization",
    buttonName: "Explore data visualization",
    expectedUrl: "/data-visualization",
  },
  {
    name: "telemetry",
    buttonName: "Try Telemetry Examples",
    expectedUrl: "/telemetry",
  },
  {
    name: "sql-helpers",
    buttonName: "Try SQL Helpers",
    expectedUrl: "/sql-helpers",
  },
  {
    name: "type-safety",
    buttonName: "Explore Type Safety",
    expectedUrl: "/type-safety",
  },
];

test.describe("Navigation Tests", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAPI(page);
  });

  for (const {
    name,
    buttonName,
    buttonIndex,
    expectedUrl,
  } of homepageNavigationTests) {
    test(`can navigate to ${name} from homepage`, async ({ page }) => {
      await page.goto("/");
      await waitForPageLoad(page);

      const button = page.getByRole("button", { name: buttonName });
      if (buttonIndex !== undefined) {
        await button.nth(buttonIndex).click();
      } else {
        await button.click();
      }

      await expect(page).toHaveURL(expectedUrl);
    });
  }

  test("navigation bar shows on non-home pages", async ({ page }) => {
    await page.goto("/analytics");
    await waitForPageLoad(page);

    await expect(
      page.getByRole("link", { name: "AppKit Playground" }),
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: "Analytics", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Arrow Analytics" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Telemetry" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "SQL Helpers" }),
    ).toBeVisible();
  });

  test("can navigate back to home from nav bar", async ({ page }) => {
    await page.goto("/analytics");
    await waitForPageLoad(page);

    await page.getByRole("link", { name: "AppKit Playground" }).click();

    await expect(page).toHaveURL("/");
  });

  test("can navigate between pages using nav bar", async ({ page }) => {
    await page.goto("/analytics");
    await waitForPageLoad(page);

    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page).toHaveURL("/reconnect");

    await page.getByRole("button", { name: "Telemetry" }).click();
    await expect(page).toHaveURL("/telemetry");

    await page.getByRole("button", { name: "SQL Helpers" }).click();
    await expect(page).toHaveURL("/sql-helpers");
  });

  test("navigation bar is hidden on homepage", async ({ page }) => {
    await page.goto("/");
    await waitForPageLoad(page);

    const navBar = page.locator("nav").filter({
      has: page.getByRole("button", { name: "Analytics" }),
    });
    await expect(navBar).not.toBeVisible();
  });
});
