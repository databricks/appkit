import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";

import { assertFinalizedSchema } from "../../../database/schema-builder/define-schema";

describe("database template starter", () => {
  test("ships a finalized empty schema, not an implicit runtime fallback", async () => {
    // The entire starter must be conditional, with no content outside the
    // database block. Validate the selected branch using the SDK source so
    // this check also runs in CI before the packages have been built.
    const template = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../../../../../template/config/database/schema.ts",
      ),
      "utf8",
    );
    const block = template.match(
      /^\{\{if \.plugins\.database -\}\}\s*([\s\S]*?)\s*\{\{- end\}\}\s*$/,
    );
    assert(block, "schema.ts must be entirely guarded by .plugins.database");
    const root = await mkdtemp(path.join(tmpdir(), "appkit-template-schema-"));
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@databricks/appkit/beta": path.resolve(
          import.meta.dirname,
          "../../../database/schema-builder/index.ts",
        ),
      },
    });
    try {
      const file = path.join(root, "schema.ts");
      await writeFile(file, block[1] + "\n");
      const { schema } = await jiti.import<{ schema: unknown }>(file);
      expect(() => assertFinalizedSchema(schema)).not.toThrow();
      assertFinalizedSchema(schema);
      expect(Object.keys(schema.$tables)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
