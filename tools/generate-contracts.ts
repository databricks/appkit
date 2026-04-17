#!/usr/bin/env tsx
// Regenerate TS bindings for the proto contracts under contracts/.
// Invoked by `pnpm --filter=@databricks/appkit-contracts generate`.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const contractsDir = resolve(repoRoot, "contracts");
const bufBin = resolve(repoRoot, "node_modules", ".bin", "buf");

const result = spawnSync(bufBin, ["generate"], {
  cwd: contractsDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
