import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

/**
 * Format a generated file with oxfmt so it matches the rest of the repo.
 * Without this, every `pnpm build`/`pnpm dev` would leave generated files
 * dirty until `pnpm format` is run.
 */
export function formatGenerated(filePath: string): void {
  const result = spawnSync("pnpm", ["exec", "oxfmt", "--write", filePath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`oxfmt --write failed for ${filePath}`);
  }
}
