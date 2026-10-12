/**
 * Density: components read spacing from CSS variables defined in
 * styles/globals.css, with a comfortable default and a
 * [data-density="compact"] override. These tests keep the two blocks in
 * sync with each other and with the components, and check that a
 * className passed by the app still beats the variable-based default.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Button } from "../button";
import { Card, CardContent, CardHeader } from "../card";
import { Input } from "../input";
import { Table, TableBody, TableCell, TableRow } from "../table";

const UI_DIR = join(import.meta.dirname, "..");
const GLOBALS_CSS = readFileSync(
  join(UI_DIR, "../styles/globals.css"),
  "utf-8",
);

function declaredVars(selector: string): string[] {
  const start = GLOBALS_CSS.indexOf(`${selector} {`);
  expect(start, `missing ${selector} block in globals.css`).toBeGreaterThan(-1);
  const block = GLOBALS_CSS.slice(start, GLOBALS_CSS.indexOf("}", start));
  return [...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]).sort();
}

const comfortable = declaredVars(':root,\n[data-density="comfortable"]');
const compact = declaredVars('[data-density="compact"]');

afterEach(() => {
  cleanup();
});

describe("density variables", () => {
  test("compact overrides exactly the variables the default defines", () => {
    expect(comfortable).toContain("--card-spacing");
    expect(compact).toEqual(comfortable);
  });

  test("every density variable is used by a component or base style", () => {
    const sources = readdirSync(UI_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(join(UI_DIR, f), "utf-8"))
      .join("\n");
    const baseLayer = GLOBALS_CSS.slice(GLOBALS_CSS.indexOf("@layer base"));
    const unused = comfortable.filter(
      (v) => !sources.includes(`(${v})`) && !sources.includes(`var(${v})`) && !baseLayer.includes(`var(${v})`),
    );
    expect(unused).toEqual([]);
  });
});

describe("components read density variables", () => {
  test("Card parts use the card spacing variables", () => {
    const { container } = render(
      <Card>
        <CardHeader>Header</CardHeader>
        <CardContent>Content</CardContent>
      </Card>,
    );
    const card = container.querySelector('[data-slot="card"]');
    expect(card?.className).toContain("py-(--card-spacing)");
    expect(card?.className).toContain("shadow-(--card-shadow)");
    expect(
      container.querySelector('[data-slot="card-content"]')?.className,
    ).toContain("px-(--card-spacing)");
  });

  test("controls share the control height", () => {
    const { getByRole } = render(
      <>
        <Button>Save</Button>
        <Input aria-label="Name" />
      </>,
    );
    expect(getByRole("button").className).toContain("h-(--control-height)");
    expect(getByRole("textbox").className).toContain("h-(--control-height)");
  });

  test("app classNames override the density defaults", () => {
    const { container, getByRole } = render(
      <>
        <Card className="py-2 shadow-lg" />
        <Button className="h-12">Wide</Button>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="p-4">Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </>,
    );
    const card = container.querySelector('[data-slot="card"]')?.className;
    expect(card).toContain("py-2");
    expect(card).toContain("shadow-lg");
    expect(card).not.toContain("py-(--card-spacing)");
    expect(card).not.toContain("shadow-(--card-shadow)");
    expect(getByRole("button").className).not.toContain("h-(--control-height)");
    const cell = container.querySelector('[data-slot="table-cell"]')?.className;
    expect(cell).toContain("p-4");
    expect(cell).not.toContain("py-(--table-cell-padding-y)");
  });
});
