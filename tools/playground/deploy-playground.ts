import { exec as execChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ora from "ora";

const exec = promisify(execChildProcess);

const config = {
  profile: process.env.DATABRICKS_PROFILE,
  appName: process.env.DATABRICKS_APP_NAME,
  workspaceDir: process.env.DATABRICKS_WORKSPACE_DIR,
};

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PLAYGROUND_FOLDER = path.join(process.cwd(), "apps", "dev-playground");
const TMP_FOLDER = path.join(process.cwd(), "deployable");

const appKitPackageJson = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "packages", "appkit", "package.json"),
    "utf-8",
  ),
);
const appKitUiPackageJson = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "packages", "appkit-ui", "package.json"),
    "utf-8",
  ),
);
const appKitTarball = path.join(
  process.cwd(),
  "packages",
  "appkit",
  "tmp",
  `databricks-appkit-${appKitPackageJson.version}.tgz`,
);
const appKitUiTarball = path.join(
  process.cwd(),
  "packages",
  "appkit-ui",
  "tmp",
  `databricks-appkit-ui-${appKitUiPackageJson.version}.tgz`,
);

async function deployPlayground() {
  const spinner = ora("Deploying playground").start();

  if (fs.existsSync(TMP_FOLDER)) {
    const databricksPath = path.join(TMP_FOLDER, ".databricks");
    if (fs.existsSync(databricksPath)) {
      fs.cpSync(databricksPath, path.join(PLAYGROUND_FOLDER, ".databricks"), {
        recursive: true,
      });
    }
    fs.rmSync(TMP_FOLDER, { recursive: true });
  }

  fs.cpSync(PLAYGROUND_FOLDER, TMP_FOLDER, { recursive: true });

  const playgroundPackageJson = JSON.parse(
    fs.readFileSync(path.join(TMP_FOLDER, "package.json"), "utf-8"),
  );
  const clientPackageJson = JSON.parse(
    fs.readFileSync(path.join(TMP_FOLDER, "client", "package.json"), "utf-8"),
  );
  const rootPreparedTSConfig = path.join(
    __dirname,
    "prepared-files",
    "root-tsconfig.json",
  );
  const clientPreparedTSConfig = path.join(
    __dirname,
    "prepared-files",
    "client-tsconfig.json",
  );
  const clientPreparedViteConfig = path.join(
    __dirname,
    "prepared-files",
    "client-viteconfig.ts",
  );
  const clientTsConfig = path.join(TMP_FOLDER, "client", "tsconfig.json");
  const rootTsConfig = path.join(TMP_FOLDER, "tsconfig.json");
  const clientViteConfig = path.join(TMP_FOLDER, "client", "vite.config.ts");

  const appName = playgroundPackageJson.name;

  playgroundPackageJson.dependencies = {
    ...playgroundPackageJson.dependencies,
    "@databricks/appkit": `file:./databricks-appkit-${appKitPackageJson.version}.tgz`,
  };

  clientPackageJson.dependencies = {
    ...clientPackageJson.dependencies,
    "@databricks/appkit-ui": `file:./databricks-appkit-ui-${appKitUiPackageJson.version}.tgz`,
  };

  fs.writeFileSync(
    path.join(TMP_FOLDER, "package.json"),
    JSON.stringify(playgroundPackageJson, null, 2),
  );
  fs.writeFileSync(
    path.join(TMP_FOLDER, "client", "package.json"),
    JSON.stringify(clientPackageJson, null, 2),
  );
  fs.copyFileSync(
    appKitTarball,
    path.join(TMP_FOLDER, `databricks-appkit-${appKitPackageJson.version}.tgz`),
  );
  fs.copyFileSync(
    appKitUiTarball,
    path.join(
      TMP_FOLDER,
      "client",
      `databricks-appkit-ui-${appKitUiPackageJson.version}.tgz`,
    ),
  );

  fs.copyFileSync(clientPreparedTSConfig, clientTsConfig);
  fs.copyFileSync(clientPreparedViteConfig, clientViteConfig);
  fs.copyFileSync(rootPreparedTSConfig, rootTsConfig);

  process.chdir(TMP_FOLDER);

  const username = os.userInfo().username;
  const scopedAppName =
    config.appName || `${transformUsername(username)}-${appName}`;
  const workspaceDir = config.workspaceDir || scopedAppName;
  const profileArgs = config.profile ? ["-p", config.profile] : [];
  const profileArgStr =
    profileArgs.length > 0 ? ` ${profileArgs.join(" ")}` : "";

  try {
    await exec(`databricks apps get ${scopedAppName}${profileArgStr}`);
  } catch {
    spinner.info(`Creating app "${scopedAppName}"...`);
    await execWithOutput("databricks", [
      "apps",
      "create",
      scopedAppName,
      ...profileArgs,
    ]);
    console.log(
      `App "${scopedAppName}" created successfully, you will need to add the sql-warehouse resource to the app manually now.`,
    );
  }

  spinner.info(`Syncing playground to Databricks`);
  const { stderr } = await exec(
    `databricks sync . /Workspace/Users/${username}@databricks.com/${workspaceDir}${profileArgStr}`,
  );

  if (stderr) {
    spinner.fail(`Failed to sync playground`);
    console.error(stderr);
    return;
  }

  spinner.info(`Deploying "${scopedAppName}" to Databricks`);
  const { stderr: stderr2 } = await exec(
    `databricks apps deploy ${scopedAppName} --source-code-path /Workspace/Users/${username}@databricks.com/${workspaceDir}${profileArgStr}`,
  );

  if (stderr2) {
    spinner.fail(`Failed to deploy "${scopedAppName}"`);
    console.error(stderr2);
    return;
  }

  spinner.succeed(`App "${scopedAppName}" deployed successfully`);
}

function cleanup(folders: string[]) {
  for (const folder of folders) {
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true });
    }
  }
}

deployPlayground()
  .catch(console.error)
  .finally(() => {
    cleanup([TMP_FOLDER, appKitTarball, appKitUiTarball]);
  });

function execWithOutput(
  command: string,
  args: string[],
): Promise<{ code: number; stderr?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    child.stdout.on("data", (data) => {
      process.stdout.write(data);
    });

    child.stderr.on("data", (data) => {
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 0 });
    });

    child.on("error", (error) => {
      reject({ stderr: error });
    });
  });
}

function transformUsername(username: string): string {
  return username.replace(/\./g, "-");
}
