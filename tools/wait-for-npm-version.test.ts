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

async function fakeRegistry(
  servedFrom: Record<string, number | "stall" | "deny">,
) {
  let arrived = () => {};
  const firstRequest = new Promise<void>((resolve) => (arrived = resolve));
  server = createServer((req, res) => {
    arrived();
    const name = decodeURIComponent(req.url?.slice(1) ?? "");
    const count = (requests.get(name) ?? 0) + 1;
    requests.set(name, count);
    const from = servedFrom[name];
    if (from === "stall") return;
    if (from === undefined || from === "deny") {
      res.writeHead(from === "deny" ? 401 : 404).end();
      return;
    }
    const versions = count >= from ? ["0.103.0", VERSION] : ["0.103.0"];
    res.writeHead(200, {
      "content-type": "application/json",
      // Cacheable like the real registry: npm must revalidate, not reuse it.
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
  return { firstRequest };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "appkit-wait-npm-test-"));
  vi.stubEnv("npm_config_cache", join(directory, "cache"));
  vi.stubEnv("npm_config_userconfig", join(directory, "npmrc"));
  vi.stubEnv("npm_config_update_notifier", "false");
});

afterEach(() => {
  server?.closeAllConnections();
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
      { cwd: directory, timeoutMs: 50_000, ...fast },
    );

    expect(requests.get("@databricks/appkit")).toBeGreaterThanOrEqual(3);
    expect(requests.get("@databricks/appkit-ui")).toBeGreaterThanOrEqual(2);
  },
);

test(
  "reads npm's answer when the environment sets npm_config_json",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({ "@databricks/appkit": 1 });
    vi.stubEnv("npm_config_json", "true");

    await waitForNpmVersion(["@databricks/appkit"], VERSION, {
      cwd: directory,
      timeoutMs: 50_000,
      ...fast,
    });
  },
);

test(
  "names the package and version when the wait times out",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({ "@databricks/appkit-ui": Infinity });

    await expect(
      waitForNpmVersion(["@databricks/appkit-ui"], VERSION, {
        cwd: directory,
        timeoutMs: 2_000,
        ...fast,
      }),
    ).rejects.toThrow(
      `@databricks/appkit-ui@${VERSION} is still not on the npm registry after 2s`,
    );
  },
);

test(
  "checks once more at the deadline instead of giving up early",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({ "@databricks/appkit": 2 });

    await waitForNpmVersion(["@databricks/appkit"], VERSION, {
      cwd: directory,
      timeoutMs: 3_000,
      delayMs: 60_000,
      maxDelayMs: 60_000,
    });

    expect(requests.get("@databricks/appkit")).toBeGreaterThanOrEqual(2);
  },
);

test(
  "fails at once on an error that waiting can't fix",
  { timeout: 60_000 },
  async () => {
    await fakeRegistry({ "@databricks/appkit": "deny" });

    await expect(
      waitForNpmVersion(["@databricks/appkit"], VERSION, {
        cwd: directory,
        timeoutMs: 50_000,
        ...fast,
      }),
    ).rejects.toThrow(`npm view @databricks/appkit@${VERSION} failed (E401)`);
    expect(requests.get("@databricks/appkit")).toBe(1);
  },
);

test(
  "a registry that never answers still ends the wait on time",
  { timeout: 60_000 },
  async () => {
    const { firstRequest } = await fakeRegistry({
      "@databricks/appkit": "stall",
    });

    const failed = expect(
      waitForNpmVersion(["@databricks/appkit"], VERSION, {
        cwd: directory,
        timeoutMs: 3_000,
        lastProbeMs: 500,
        ...fast,
      }),
    ).rejects.toThrow("npm view did not answer in time");
    await firstRequest;
    const stalledAt = Date.now();
    await failed;

    // npm alone would wait out its 5-minute fetch timeout.
    expect(Date.now() - stalledAt).toBeLessThan(10_000);
  },
);
