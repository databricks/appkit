import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { lockInTsxDraft } from "./tsx-drafts";

function appWithDrafts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-tsx-"));
  const design = path.join(root, "client/src/design");
  fs.mkdirSync(path.join(design, "pages"), { recursive: true });
  fs.mkdirSync(path.join(design, ".staging"), { recursive: true });
  const drafts = ["d-a", "d-b", "d-c"].map((name) => ({ name }));
  fs.writeFileSync(
    path.join(design, ".staging/status.json"),
    JSON.stringify({ drafts }),
  );
  fs.writeFileSync(path.join(design, "mock.ts"), "export const x = 1;\n");
  for (const { name } of drafts) {
    fs.writeFileSync(
      path.join(design, "pages", `${name}.tsx`),
      `import { x } from "../mock";\nexport default () => x; // ${name}\n`,
    );
  }
  // Not a draft of the run: must survive lock-in.
  fs.writeFileSync(path.join(design, "pages/other.tsx"), "");
  return { root, design };
}

describe("lockInTsxDraft", () => {
  test("the chosen draft becomes /design and the others are deleted", async () => {
    const { root, design } = appWithDrafts();
    await lockInTsxDraft(root, "d-b");
    expect(fs.readFileSync(path.join(design, "index.tsx"), "utf8")).toBe(
      'import { x } from "./mock";\nexport default () => x; // d-b\n',
    );
    expect(fs.readdirSync(path.join(design, "pages"))).toEqual(["other.tsx"]);
    expect(fs.existsSync(path.join(design, ".staging"))).toBe(false);
    expect(fs.existsSync(path.join(design, "mock.ts"))).toBe(true);
  });

  test("--home moves it and its mock to the home page", async () => {
    const { root, design } = appWithDrafts();
    const target = await lockInTsxDraft(root, "d-a", { home: true });
    expect(target).toBe(path.join(root, "client/src/pages/home/HomePage.tsx"));
    expect(
      fs.existsSync(path.join(root, "client/src/pages/home/mock.ts")),
    ).toBe(true);
    expect(fs.existsSync(path.join(design, "mock.ts"))).toBe(false);
  });

  test("an unknown draft is an error", async () => {
    const { root } = appWithDrafts();
    await expect(lockInTsxDraft(root, "nope")).rejects.toThrow(
      'No TSX draft named "nope"',
    );
  });
});
