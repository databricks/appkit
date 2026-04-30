import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

/**
 * Run Biome on a generated file so its formatting matches the rest of the
 * repo. Without this, every `pnpm build`/`pnpm dev` would leave generated
 * files dirty until `pnpm format` is run.
 */
export function formatWithBiome(filePath: string): void {
  const result = spawnSync(
    "pnpm",
    ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", filePath],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`biome check --write failed for ${filePath}`);
  }
}
