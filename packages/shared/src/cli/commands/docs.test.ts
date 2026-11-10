import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { apiIndex, lookupNames } from "./docs";

const anchor = (title: string) =>
  `[\u200b](#${title.toLowerCase()} "Direct link to ${title}")`;

const chartPage = (name: string, ownProp: string) =>
  [
    `# ${name}`,
    "",
    `${name} component.`,
    "",
    `## Example${anchor("Example")}`,
    "",
    "```tsx",
    `<${name} data={rows} />`,
    "```",
    "",
    `## ${name}${anchor(name)}`,
    "",
    `### Props${anchor("Props")}`,
    "",
    "| Prop | Type | Required | Default | Description |",
    "| ---- | ---- | -------- | ------- | ----------- |",
    "| `height` | `number` | | `300` | Chart height in pixels. Applies to the canvas. |",
    `| \`${ownProp}\` | \`string \\| string[]\` | | - | - |`,
  ].join("\n");

const files: Record<string, string> = {
  "docs/api/appkit-ui/data/BarChart.md": chartPage("BarChart", "stacked"),
  "docs/api/appkit-ui/data/LineChart.md": chartPage("LineChart", "smooth"),
  "docs/api/appkit-ui/ui/Calendar.md": [
    "# Calendar",
    "",
    "Date picker component for selecting single dates or date ranges",
  ].join("\n"),
  "docs/api/appkit-ui/ui/Select.md": [
    "# Select",
    "",
    "Dropdown control",
    "",
    `## SelectItem${anchor("SelectItem")}`,
    "",
    "One option",
  ].join("\n"),
  "docs/api/appkit/Variable.sql.md": [
    "# Variable: sql",
    "",
    "```ts",
    "const sql: { string: SQLStringMarker };",
    "```",
    "",
    `## Type Declaration${anchor("Type Declaration")}`,
    "",
    "### string()",
    "",
    "```ts",
    "string(value: string): SQLStringMarker;",
    "```",
  ].join("\n"),
  "docs/plugins/analytics.md": [
    "# Analytics plugin",
    "",
    `### useAnalyticsQuery${anchor("useAnalyticsQuery")}`,
    "",
    "Subscribes to an analytics query.",
    "",
    "### Memoization",
  ].join("\n"),
};

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-docs-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("appkit docs NAME...", () => {
  test("indexes component pages, their parts, reference pages and hooks", () => {
    const names = [...apiIndex(root).keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        "BarChart",
        "Select",
        "SelectItem",
        "sql",
        "useAnalyticsQuery",
      ]),
    );
    expect(names).not.toContain("Props");
    expect(names).not.toContain("Memoization");
  });

  test("prints one name in full, props one per line", () => {
    const out = lookupNames(root, ["BarChart"]);
    expect(out).toContain("<BarChart data={rows} />");
    expect(out).toContain(
      "- height?: number = 300 — Chart height in pixels. Applies to the canvas.",
    );
    expect(out).toContain("- stacked?: string | string[]");
    expect(out).not.toContain("Direct link");
  });

  test("prints several names without examples, and a shared prop once", () => {
    const out = lookupNames(root, ["BarChart", "LineChart", "sql"]);
    expect(out).not.toContain("<BarChart data={rows} />");
    expect(out).toContain(
      "- height?: number = 300 — Chart height in pixels.\n",
    );
    expect(out).toContain("- height: as in BarChart");
    expect(out).toContain("- smooth?: string | string[]");
    expect(out).toContain("Members: string()");
    expect(out).not.toContain("string(value: string)");
  });

  test("names what it cannot find, with similar names", () => {
    expect(lookupNames(root, ["SelectOption"])).toContain(
      "Not documented. Similar: SelectItem, Select",
    );
  });

  test("suggests a component whose description matches an unknown name", () => {
    expect(lookupNames(root, ["DateRangePicker"])).toContain(
      "Not documented. Similar: Calendar",
    );
  });
});
