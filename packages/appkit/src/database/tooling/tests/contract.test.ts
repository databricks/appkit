import { expect, test } from "vitest";

import type { DatabaseTooling } from "../../../../../shared/src/cli/commands/db/tooling-contract";
import type { DbContext } from "../context";
import * as tooling from "../index";

const toolingMatchesCliContract: DatabaseTooling<DbContext> = tooling;

const contractKeys = {
  createDbContext: true,
  runCheck: true,
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
    expect(typeof toolingMatchesCliContract[key]).toBe("function");
  }
});
