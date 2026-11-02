import { expect, test } from "vitest";

import type { DatabaseTooling } from "../../../../../shared/src/cli/commands/db/tooling-contract";
import type { DbContext } from "../context";
import * as tooling from "../index";

// The CLI in `shared` types this module with DatabaseTooling and cannot see
// these exports, so the assignment below is what keeps the two in step.
const exports: DatabaseTooling<DbContext> = tooling;

const contractKeys = {
  createDbContext: true,
  deleteSessionBranch: true,
  previewClean: true,
  runClean: true,
  runInit: true,
  runIntrospect: true,
  runMigrate: true,
  runSeed: true,
  runVerify: true,
} satisfies Record<keyof DatabaseTooling, true>;

test("every function the CLI is typed with is exported", () => {
  for (const key of Object.keys(contractKeys) as (keyof DatabaseTooling)[]) {
    expect(typeof exports[key]).toBe("function");
  }
});
