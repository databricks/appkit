import { expect, test } from "@playwright/test";

test.describe("Smoke Tests", () => {
  test("app loads and displays homepage", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    await expect(
      page.getByRole("heading", { name: "AppKit Playground" }),
    ).toBeVisible();

    await expect(
      page.getByText("Explore the capabilities of the AppKit"),
    ).toBeVisible();
  });

  test("no console errors on page load", async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/", { waitUntil: "networkidle" });

    expect(
      consoleErrors,
      `Console errors detected: ${consoleErrors.join(", ")}`,
    ).toHaveLength(0);
  });
});
