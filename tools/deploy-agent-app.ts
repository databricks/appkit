import { exec as execChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ora from "ora";

const _exec = promisify(execChildProcess);

const config = {
  profile: process.env.DATABRICKS_PROFILE,
  appName: process.env.DATABRICKS_APP_NAME,
};

const ROOT = process.cwd();
const AGENT_APP_DIR = path.join(ROOT, "apps", "agent-app");
const DEPLOY_DIR = path.join(ROOT, "deployable-agent");

const appKitPkg = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "packages", "appkit", "package.json"),
    "utf-8",
  ),
);
const appKitUiPkg = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "packages", "appkit-ui", "package.json"),
    "utf-8",
  ),
);
const appKitTarball = path.join(
  ROOT,
  "packages",
  "appkit",
  "tmp",
  `databricks-appkit-${appKitPkg.version}.tgz`,
);
const appKitUiTarball = path.join(
  ROOT,
  "packages",
  "appkit-ui",
  "tmp",
  `databricks-appkit-ui-${appKitUiPkg.version}.tgz`,
);

async function deploy() {
  const spinner = ora("Deploying agent-app").start();

  if (!fs.existsSync(appKitTarball) || !fs.existsSync(appKitUiTarball)) {
    spinner.fail(
      "Tarballs not found. Run `pnpm pack:sdk` first to build them.",
    );
    process.exit(1);
  }

  if (fs.existsSync(DEPLOY_DIR)) {
    const databricksState = path.join(DEPLOY_DIR, ".databricks");
    if (fs.existsSync(databricksState)) {
      fs.cpSync(databricksState, path.join(AGENT_APP_DIR, ".databricks"), {
        recursive: true,
      });
    }
    fs.rmSync(DEPLOY_DIR, { recursive: true });
  }

  spinner.text = "Copying agent-app to deploy folder";
  fs.cpSync(AGENT_APP_DIR, DEPLOY_DIR, {
    recursive: true,
    filter: (src) =>
      !src.includes("node_modules") && !src.includes(".databricks"),
  });

  spinner.text = "Patching package.json with tarballs";
  const pkgPath = path.join(DEPLOY_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  pkg.dependencies["@databricks/appkit"] =
    `file:./databricks-appkit-${appKitPkg.version}.tgz`;
  pkg.dependencies["@databricks/appkit-ui"] =
    `file:./databricks-appkit-ui-${appKitUiPkg.version}.tgz`;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  spinner.text = "Copying tarballs";
  fs.copyFileSync(
    appKitTarball,
    path.join(DEPLOY_DIR, `databricks-appkit-${appKitPkg.version}.tgz`),
  );
  fs.copyFileSync(
    appKitUiTarball,
    path.join(DEPLOY_DIR, `databricks-appkit-ui-${appKitUiPkg.version}.tgz`),
  );

  spinner.text = "Patching vite.config.ts (removing monorepo aliases)";
  const viteConfigPath = path.join(DEPLOY_DIR, "vite.config.ts");
  if (fs.existsSync(viteConfigPath)) {
    let viteConfig = fs.readFileSync(viteConfigPath, "utf-8");
    viteConfig = viteConfig
      .replace(/import path from "node:path";\n?/, "")
      .replace(/alias:\s*\{[^}]*\},?\n?/s, "")
      .replace(/preserveSymlinks:\s*true,?\n?/, "")
      .replace(/exclude:\s*\[[^\]]*\],?\n?/, "");
    fs.writeFileSync(viteConfigPath, viteConfig);
  }

  process.chdir(DEPLOY_DIR);

  const username = os.userInfo().username;
  const appName =
    config.appName || `${username.replace(/\./g, "-")}-appkit-agent`;
  const profileArgs = config.profile ? ["-p", config.profile] : [];

  spinner.info(`Deploying as "${appName}"`);
  await execWithOutput("databricks", [
    "apps",
    "deploy",
    "--skip-validation",
    ...profileArgs,
  ]);

  spinner.succeed(`Agent app "${appName}" deployed`);
}

function execWithOutput(
  command: string,
  args: string[],
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code) => resolve({ code: code ?? 0 }));
    child.on("error", reject);
  });
}

deploy()
  .catch((err) => {
    console.error("Deploy failed:", err);
    process.exit(1);
  })
  .finally(() => {
    if (fs.existsSync(DEPLOY_DIR)) {
      fs.rmSync(DEPLOY_DIR, { recursive: true });
    }
  });
