import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const chartsDir = resolve(root, "packages/appkit-ui/src/react/charts");

// Every chart component built by the factory, e.g. `export const BarChart = createChart<...>(`
const chartNames = readdirSync(chartsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "__tests__")
  .flatMap((entry) => [
    ...readFileSync(
      resolve(chartsDir, entry.name, "index.tsx"),
      "utf-8",
    ).matchAll(/^export const (\w+) = createChart\b/gm),
  ])
  .map((match) => match[1]);

describe("generated chart docs", () => {
  test("finds the exported charts", () => {
    expect(chartNames).toEqual(
      expect.arrayContaining(["BarChart", "DonutChart", "PieChart"]),
    );
  });

  // Guards against the pages silently disappearing again (see #170, which dropped them)
  test.each(chartNames)("%s has a page with a props table", (name) => {
    const page = readFileSync(
      resolve(root, `docs/docs/api/appkit-ui/data/${name}.mdx`),
      "utf-8",
    );
    expect(page).toContain(`# ${name}`);
    expect(page).toContain("### Props");
    expect(page).toContain("| `queryKey` |");
    expect(page).toContain("| `data` |");
  });
});
