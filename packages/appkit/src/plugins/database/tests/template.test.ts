import path from "node:path";

import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";

import { assertFinalizedSchema } from "../../../database/schema-builder/define-schema";

describe("database template starter", () => {
  test("ships a finalized empty schema, not an implicit runtime fallback", async () => {
    // Load the actual template file. Resolve its SDK import from source so
    // this check also runs in CI before the packages have been built.
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@databricks/appkit/beta": path.resolve(
          import.meta.dirname,
          "../../../database/schema-builder/index.ts",
        ),
      },
    });
    const { schema } = await jiti.import<{ schema: unknown }>(
      path.resolve(
        import.meta.dirname,
        "../../../../../../template/config/database/schema.ts",
      ),
    );
    expect(() => assertFinalizedSchema(schema)).not.toThrow();
    assertFinalizedSchema(schema);
    expect(Object.keys(schema.$tables)).toEqual([]);
  });
});
