import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { waitForNpmVersion } from "./wait-for-npm-version";

const VERSION = "0.104.0";
const fast = { delayMs: 10, maxDelayMs: 20 };
let directory: string;
let server: Server;
const requests = new Map<string, number>();

/**
 * A registry that serves `name@VERSION` only from request `servedFrom[name]`
 * on; before that it returns the pre-publish packument, cacheable like npm's.
 */
async function fakeRegistry(servedFrom: Record<string, number>) {
  server = createServer((req, res) => {
    const name = decodeURIComponent(req.url?.slice(1) ?? "");
    const count = (requests.get(name) ?? 0) + 1;
    requests.set(name, count);
    if (!(name in servedFrom)) {
      res.writeHead(404).end();
      return;
    }
    const versions =
      count >= servedFrom[name] ? ["0.103.0", VERSION] : ["0.103.0"];
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    });
    res.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: versions.at(-1) },
        versions: Object.fromEntries(
          versions.map((version) => [
            version,
            {
              name,
              version,
              dist: { tarball: `http://unused/${version}.tgz` },
            },
          ]),
        ),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // Both spellings: npm reads either, and the developer's env may set one.
  vi.stubEnv("npm_config_registry", registry);
  vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "appkit-wait-npm-test-"));
  vi.stubEnv("npm_config_cache", join(directory, "cache"));
  vi.stubEnv("npm_config_userconfig", join(directory, "npmrc"));
  vi.stubEnv("npm_config_update_notifier", "false");
});

afterEach(() => {
  server?.close();
  requests.clear();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test(
  "waits until the registry serves every package",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({ "@databricks/appkit": 3, "@databricks/appkit-ui": 2 });

    await waitForNpmVersion(
      ["@databricks/appkit", "@databricks/appkit-ui"],
      VERSION,
      {
        cwd: directory,
        timeoutMs: 50_000,
        ...fast,
      },
    );

    // One request per try: the cached stale packument is never trusted.
    expect(requests.get("@databricks/appkit")).toBe(3);
    expect(requests.get("@databricks/appkit-ui")).toBe(2);
  },
);

test(
  "names the package and version when the wait times out",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({
      "@databricks/appkit": 1,
      "@databricks/appkit-ui": Infinity,
    });

    await expect(
      waitForNpmVersion(
        ["@databricks/appkit", "@databricks/appkit-ui"],
        VERSION,
        {
          cwd: directory,
          timeoutMs: 1_000,
          ...fast,
        },
      ),
    ).rejects.toThrow(
      `@databricks/appkit-ui@${VERSION} is still not on the npm registry`,
    );
  },
);
