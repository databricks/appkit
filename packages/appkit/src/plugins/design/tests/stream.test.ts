import { transformWithOxc } from "vite";
import { describe, expect, test } from "vitest";

import { closeOpen, mockImports, renderablePartial, stubMock } from "../stream";

const parses = async (code: string) => {
  try {
    await transformWithOxc(code, "page.tsx", { lang: "tsx" });
    return true;
  } catch {
    return false;
  }
};

const PAGE = `import { Card, CardTitle } from "@databricks/appkit-ui/react";
import { useState } from "react";

import { trips, type Trip } from "../mock";

export default function Page() {
  const [tab, setTab] = useState<string>("all");
  const rows: Trip[] = tab === "all" ? trips : trips.filter((t) => t.borough === tab && t.fare > 1);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl">Trips {\`(\${rows.length})\`}</h1>
      {rows.length > 0 && (
        <Card>
          <CardTitle>Don't miss it</CardTitle>
          {rows.map((t) => (
            <Row key={t.id} trip={t} onPick={() => setTab(t.borough)} />
          ))}
        </Card>
      )}
      <Footer />
    </div>
  );
}

function Row({ trip, onPick }: { trip: Trip; onPick: () => void }) {
  return <button onClick={onPick}>{trip.borough}</button>;
}

function Footer() {
  return <p>/ end</p>;
}
`;

describe("closeOpen", () => {
  test("closes JSX elements, expression containers and brackets", () => {
    expect(
      closeOpen(
        'return (\n  <div className="a">\n    {rows.map((t) => (\n      <Card>',
      ),
    ).toBe(
      'return (\n  <div className="a">\n    {rows.map((t) => (\n      <Card></Card>))}</div>)',
    );
  });

  test("an unfinished opening tag is self-closed", () => {
    expect(closeOpen('<div>\n  <Badge\n    variant="x"')).toBe(
      '<div>\n  <Badge\n    variant="x" /></div>',
    );
  });

  test("generics and comparisons are not JSX", () => {
    expect(closeOpen("const [a] = useState<number>(0);\nif (a < b) {")).toBe(
      "const [a] = useState<number>(0);\nif (a < b) {}",
    );
  });

  test("a cut inside a string or comment can't be closed", () => {
    expect(closeOpen('const a = "abc')).toBeNull();
    expect(closeOpen("/* note")).toBeNull();
  });
});

describe("renderablePartial", () => {
  test("every line prefix of a page is renderable once its default export starts", async () => {
    const lines = PAGE.split("\n");
    const start = lines.findIndex((l) => l.startsWith("export default"));
    for (let i = start + 2; i <= lines.length; i++) {
      const prefix = `${lines.slice(0, i).join("\n")}\n`;
      const code = await renderablePartial(prefix, parses);
      expect(code, `prefix of ${i} lines`).not.toBeNull();
      expect(await parses(code as string)).toBe(true);
    }
  });

  test("helpers not written yet are stubbed", async () => {
    const cut = PAGE.slice(0, PAGE.indexOf("function Row"));
    const code = (await renderablePartial(cut, parses)) as string;
    expect(code).toContain("function Row() { return null; }");
    expect(code).toContain("function Footer() { return null; }");
  });

  test("nothing before the default export", async () => {
    expect(
      await renderablePartial(PAGE.slice(0, PAGE.indexOf("export")), parses),
    ).toBeNull();
  });

  test("a complete source is used as is", async () => {
    expect(await renderablePartial(PAGE, parses, { complete: true })).toBe(
      PAGE,
    );
  });
});

describe("stubMock", () => {
  test("stubs the values a page imports that the mock doesn't export yet", () => {
    expect(mockImports(PAGE)).toEqual(["trips"]);
    // The contract comment lists trips before it is defined.
    const mock =
      "export type Trip = { id: number };\n// export const trips: Trip[]\nexport const kpis = {};";
    expect(stubMock(mock, ["trips", "kpis"])).toBe(
      `${mock}\nexport const trips: any = [];\n`,
    );
  });
});
