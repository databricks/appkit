import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parse } from "yaml";

export type PackageManager = "npm" | "pnpm";

/** Test fixture shaping; end-user package-manager selection belongs to the CLI. */
export function selectSmokePackageManager(
  appDir: string,
  pm: PackageManager,
): void {
  if (pm === "pnpm") {
    rmSync(join(appDir, "package-lock.json"), { force: true });
    return;
  }
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) {
    rmSync(join(appDir, file), { force: true });
  }
  const packagePath = join(appDir, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
  pkg.packageManager = `npm@${execFileSync("npm", ["--version"], { encoding: "utf-8" }).trim()}`;
  for (const [name, script] of Object.entries<string>(pkg.scripts)) {
    pkg.scripts[name] = script
      .split(" && ")
      .map((command) => command.replace(/^pnpm run /, "npm run "))
      .join(" && ");
  }
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const nativeCheck = `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const napiRequire = createRequire(require.resolve('@ast-grep/napi'));
if (process.platform === 'linux' && process.arch === 'x64') {
  napiRequire('@ast-grep/napi-linux-x64-gnu');
}
const { Lang, parse } = require('@ast-grep/napi');
assert.equal(parse(Lang.JavaScript, 'const value = 1;').root().kind(), 'program');
console.log('Native parser loaded and exercised');
`;

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function runTemplateSmoke(
  appDir: string,
  pm: PackageManager,
): Promise<void> {
  const guardDir = mkdtempSync(join(tmpdir(), "appkit-smoke-pm-"));
  const unexpectedRequests: string[] = [];
  const workspace = createHttpServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === "/api/2.0/preview/scim/v2/Me"
    ) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "smoke-test",
          userName: "smoke@example.invalid",
          active: true,
        }),
      );
    } else {
      unexpectedRequests.push(`${request.method} ${request.url}`);
      response.writeHead(500).end("Unexpected workspace request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    workspace.once("error", reject);
    workspace.listen(0, "127.0.0.1", resolve);
  });
  const workspaceAddress = workspace.address();
  assert(workspaceAddress && typeof workspaceAddress === "object");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(DATABRICKS_|OTEL_|MLFLOW_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    CI: "true",
    DO_NOT_TRACK: "1",
    OTEL_SDK_DISABLED: "true",
    DATABRICKS_HOST: `http://127.0.0.1:${workspaceAddress.port}`,
    DATABRICKS_TOKEN: "smoke-test",
    DATABRICKS_WORKSPACE_ID: "smoke-test",
    FLASK_RUN_HOST: "127.0.0.1",
  });
  if (pm === "npm") {
    writeFileSync(
      join(guardDir, "pnpm"),
      "#!/bin/sh\necho 'npm smoke test must not invoke pnpm' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    env.PATH = `${guardDir}${delimiter}${env.PATH ?? ""}`;
  }
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, {
      cwd: appDir,
      env,
      stdio: "inherit",
      timeout: 180_000,
    });

  try {
    if (pm === "npm") {
      const lockPath = join(appDir, "package-lock.json");
      const committedLock = readFileSync(lockPath);
      run("npm", ["install", "--no-audit", "--no-fund"]);
      run(process.execPath, ["--input-type=commonjs", "-e", nativeCheck]);
      // npm install may repair the lock. Check the original lock used by apps init, too.
      writeFileSync(lockPath, committedLock);
      run("npm", ["ci", "--no-audit", "--no-fund"]);
    } else {
      run("pnpm", ["install", "--frozen-lockfile"]);
      const host: Record<string, string> = {
        os: process.platform,
        cpu: process.arch,
      };
      if (process.platform === "linux") {
        const report = process.report.getReport() as {
          header: { glibcVersionRuntime?: string };
        };
        host.libc = report.header.glibcVersionRuntime ? "glibc" : "musl";
      }
      for (const manifest of globSync(
        "node_modules/.pnpm/*/node_modules/{*,@*/*}/package.json",
        { cwd: appDir },
      )) {
        const pkg = JSON.parse(readFileSync(join(appDir, manifest), "utf-8"));
        if (!pkg.cpu) continue;
        for (const [field, current] of Object.entries(host)) {
          const supported: string[] | undefined = pkg[field];
          if (!supported) continue;
          assert(
            !supported.includes(`!${current}`) &&
              (supported.includes(current) ||
                supported.includes("any") ||
                supported.every((value) => value.startsWith("!"))),
            `Installed incompatible ${field} binary: ${pkg.name}`,
          );
        }
      }
    }
    run(process.execPath, ["--input-type=commonjs", "-e", nativeCheck]);
    run(pm, ["run", "build"]);
    const html = readFileSync(join(appDir, "client/dist/index.html"), "utf-8");
    assert(readFileSync(join(appDir, "dist/server.js"), "utf-8").length > 0);
    const manifest = parse(readFileSync(join(appDir, "app.yaml"), "utf-8"));
    assert.deepEqual(manifest.command, [pm, "run", "start"]);
    const port = await freePort();
    env.DATABRICKS_APP_PORT = String(port);
    const child = spawn(manifest.command[0], manifest.command.slice(1), {
      cwd: appDir,
      env,
      stdio: "inherit",
      detached: true,
    });
    let startError: Error | undefined;
    child.once("error", (error) => {
      startError = error;
    });
    try {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (startError) throw startError;
        assert(
          child.exitCode === null && child.signalCode === null,
          "App exited before becoming ready",
        );
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) {
            assert.deepEqual(await response.json(), { status: "ok" });
            ready = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException))
            throw error;
        }
        await delay(200);
      }
      assert(ready, "App did not become healthy within 30 seconds");
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      // AppKit injects runtime configuration into the built HTML.
      const servedHtml = await response.text();
      assert(servedHtml.includes('<div id="root"></div>'));
      const assetPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      assert(assetPath, "Built HTML must reference a client bundle");
      assert(servedHtml.includes(assetPath));
      const assetResponse = await fetch(
        `http://127.0.0.1:${port}${assetPath}`,
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(assetResponse.status, 200);
      assert.equal(
        await assetResponse.text(),
        readFileSync(join(appDir, "client/dist", assetPath), "utf-8"),
      );
      assert.deepEqual(unexpectedRequests, []);
      console.log(`${pm}: full build, health check, and client serving passed`);
    } finally {
      if (child.pid) {
        const pid = child.pid;
        const signal = (name: NodeJS.Signals | 0): boolean => {
          try {
            process.kill(-pid, name);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            return false;
          }
        };
        if (signal("SIGTERM")) {
          for (let attempt = 0; attempt < 50 && signal(0); attempt++)
            await delay(100);
          signal("SIGKILL");
        }
      }
    }
  } finally {
    workspace.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      workspace.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(guardDir, { recursive: true, force: true });
  }
}
