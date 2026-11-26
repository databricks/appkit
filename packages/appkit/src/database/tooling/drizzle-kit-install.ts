import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  declaredPackageManager,
  detectPackageManager,
  type PackageManager,
} from "../../../../shared/src/cli/package-manager";
import { DRIZZLE_KIT_VERSION, drizzleKitVersionAt } from "./migrations";

export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => void;

const INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  pnpm: ["add", "-D", "-E"],
  yarn: ["add", "-D", "-E"],
  bun: ["add", "-d", "--exact"],
  npm: ["install", "--save-dev", "--save-exact"],
};

interface Install {
  readonly command: string;
  readonly args: readonly string[];
}

export function drizzleKitInstall(root: string): Install {
  let manager: PackageManager | null = null;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    manager = declaredPackageManager(dir);
    if (
      manager ||
      fs.existsSync(path.join(dir, ".git")) ||
      dir === path.dirname(dir)
    ) {
      break;
    }
  }
  const command = manager ?? detectPackageManager(root, "npm");
  return {
    command,
    args: [...INSTALL_ARGS[command], `drizzle-kit@${DRIZZLE_KIT_VERSION}`],
  };
}

export const runCommand: RunCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    // Windows runs package managers through their .cmd shims.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${[command, ...args].join(" ")} exited with code ${result.status}${output ? `: ${output}` : ""}`,
    );
  }
};

export function ensureDrizzleKit(
  root: string,
  run: RunCommand,
  onStep: (message: string) => void,
): string | null {
  const found = drizzleKitVersionAt(root);
  if (
    found === DRIZZLE_KIT_VERSION ||
    !fs.existsSync(path.join(root, "package.json"))
  ) {
    return null;
  }
  const { command, args } = drizzleKitInstall(root);
  const line = [command, ...args].join(" ");
  onStep(
    `Installing drizzle-kit ${DRIZZLE_KIT_VERSION}${found ? ` in place of ${found}` : ""}, which writes migrations (${line})`,
  );
  try {
    run(command, args, root);
  } catch (error) {
    throw new Error(
      `Installing drizzle-kit failed. Run \`${line}\`, then rerun \`appkit db init\`.`,
      { cause: error },
    );
  }
  return line;
}
