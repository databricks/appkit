import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { lookUp as lookUpIn, type Section } from "./docs";

const SECTIONS: Section[] = ["appkit-ui API reference", "Plugins"].map(
  (name) => ({ name, body: "", collapsed: false }),
);

const anchor = (title: string) =>
  `[\u200b](#${title.toLowerCase()} "Direct link to ${title}")`;

const chartPage = (name: string, ownProp: string) =>
  [
    `# ${name}`,
    "",
    `${name} component.`,
    "",
    "**Important:** Configure it via props.",
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
  "docs/api/appkit-ui/ui/Card.md": [
    "# Card",
    "",
    "Groups content",
    "",
    "## Card",
    "",
    "Groups content",
    "",
    "### Props",
    "",
    "This component extends standard HTML element attributes.",
    "",
    "## CardTitle",
    "",
    "### Props",
    "",
    "This component extends standard HTML element attributes.",
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
  "docs/api/appkit-ui/styling.md": [
    "# Styling",
    "",
    "### Sidebar",
    "",
    "Sidebar colors",
  ].join("\n"),
  "docs/api/appkit/Class.Plugin.md": [
    "# Class: Plugin",
    "",
    "### start()",
    "",
    "#### Returns",
    "",
    "`void`",
    "",
    "### stop()",
    "",
    "#### Returns",
    "",
    "`void`",
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
    "```bash",
    "# not a heading",
    "```",
    "",
    "Returns rows.",
    "",
    "### Memoization",
  ].join("\n"),
};

let root: string;

const lookUp = (r: string, queries: string[]) =>
  lookUpIn(r, queries, SECTIONS)?.text ?? null;

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
  test("finds component parts, reference pages and hooks documented in guides", () => {
    expect(lookUp(root, ["SelectItem"])).toContain("One option");
    expect(lookUp(root, ["sql"])).toContain("const sql:");
    expect(lookUp(root, ["useAnalyticsQuery"])).toContain("Returns rows.");
    expect(lookUp(root, ["Sidebar"])).toContain("Not documented.");
    expect(lookUp(root, ["Plugin"])?.match(/`void`/g)).toHaveLength(2);
    const card = lookUp(root, ["Card"]) ?? "";
    expect(card.match(/Groups content/g)).toHaveLength(1);
    expect(
      card.match(/extends standard HTML element attributes/g),
    ).toHaveLength(2);
  });

  test("treats a single argument as a section only when it matches one and is not all names", () => {
    expect(lookUp(root, ["appkit-ui API reference"])).toBeNull();
    expect(lookUp(root, ["plugins"])).toBeNull();
    expect(lookUp(root, ["BarChart LineChart"])).toContain("=== LineChart");
    const miss = lookUpIn(root, ["Memoization"], SECTIONS);
    expect(miss?.found).toBe(false);
    expect(miss?.text).toContain("Sections: appkit-ui API reference, Plugins");
  });

  test("prints one name in full, props one per line", () => {
    const out = lookUp(root, ["BarChart"]);
    expect(out).toContain("<BarChart data={rows} />");
    expect(out).toContain(
      "- height?: number = 300 — Chart height in pixels. Applies to the canvas.",
    );
    expect(out).toContain("- stacked?: string | string[]");
    expect(out).not.toContain("Direct link");
  });

  test("prints several names without examples, and what they share once", () => {
    const out = lookUp(root, ["BarChart", "LineChart", "sql"]) ?? "";
    expect(out).not.toContain("<BarChart data={rows} />");
    expect(out).toContain(
      "- height?: number = 300 — Chart height in pixels.\n",
    );
    expect(out).toContain("- height: as in BarChart");
    expect(out.match(/Configure it via props/g)).toHaveLength(1);
    expect(out).toContain("(as in BarChart)");
    expect(out).toContain("- smooth?: string | string[]");
    expect(out).toContain("Members: string()");
    expect(out).not.toContain("string(value: string)");
  });

  test("names what it cannot find, with similar names", () => {
    expect(lookUp(root, ["SelectOption"])).toContain(
      "Not documented. Similar: SelectItem, Select",
    );
  });

  test("suggests a component whose description matches an unknown name", () => {
    expect(lookUp(root, ["DateRangePicker"])).toContain(
      "Not documented. Similar: Calendar",
    );
  });
});
