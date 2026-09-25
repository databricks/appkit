import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertPackageImportsResolve } from "@tools/validate-package-imports";
import { afterEach, describe, expect, test } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-package-imports-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return dir;
}

describe("published package imports", () => {
  test("accepts relative imports included in the package", () => {
    const dir = fixture({
      "cli/command.js": [
        'import { helper } from "../helper.js";',
        'const example = `import missing from "../not-an-import.js"`;',
      ].join("\n"),
      "helper.js": "export const helper = true;",
    });

    expect(() => assertPackageImportsResolve(dir)).not.toThrow();
  });

  test("rejects a CLI command whose relative helper was not packaged", () => {
    const dir = fixture({
      "cli/commands/dev-obo.js":
        'import { loadDevOboIdentity } from "../../dev-obo.js";',
    });

    expect(() => assertPackageImportsResolve(dir)).toThrow(
      "cli/commands/dev-obo.js -> ../../dev-obo.js",
    );
  });
});
