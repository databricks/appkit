import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import { devOboCommand, loadDevOboIdentity, startDevOboProxy } from "./dev-obo";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});
function origin(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return `http://127.0.0.1:${address.port}`;
}

describe("local OBO proxy", () => {
  test("passes the explicit profile to credential commands without leaking failures", async () => {
    const run = vi.fn(async (args: string[]) => ({
      stdout: JSON.stringify(
        args[0] === "auth"
          ? { access_token: "fake-token" }
          : { id: "alice", userName: "alice@example.com" },
      ),
    }));
    expect(await loadDevOboIdentity("chosen", run)).toEqual({
      token: "fake-token",
      userId: "alice",
      email: "alice@example.com",
    });
    expect(run).toHaveBeenCalledWith(["auth", "token", "--profile", "chosen"]);
    expect(run).toHaveBeenCalledWith([
      "current-user",
      "me",
      "--profile",
      "chosen",
      "--output",
      "json",
    ]);
    run.mockRejectedValue(new Error("fake-token"));
    const error = await loadDevOboIdentity("chosen", run).catch((err) => err);
    expect(String(error)).not.toContain("fake-token");
    expect(error.cause).toBeUndefined();
  });
  test("requires an explicit profile at the CLI boundary", async () => {
    devOboCommand.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(
      devOboCommand.parseAsync(["--target", "http://127.0.0.1:3000"], {
        from: "user",
      }),
    ).rejects.toThrow("--profile");
  });

  test("injects credentials only into the local upstream and refreshes them", async () => {
    const received: IncomingHttpHeaders[] = [];
    const bodies: string[] = [];
    const app = createServer((req, res) => {
      received.push(req.headers);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        res.end("ok");
      });
    });
    servers.push(app);
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const load = vi.fn().mockResolvedValue({
      token: "fake-token-1",
      userId: "alice",
      email: "alice@example.com",
    });
    const proxy = await startDevOboProxy({
      target: origin(app),
      port: 0,
      loadIdentity: load,
    });
    servers.push(proxy);
    const response = await fetch(`${origin(proxy)}/query`, {
      method: "POST",
      body: "request body",
      headers: {
        "x-forwarded-user": "untrusted",
        "x-forwarded-access-token": "untrusted",
      },
    });
    expect(await response.text()).toBe("ok");
    expect(received[0]).toMatchObject({
      "x-forwarded-user": "alice",
      "x-forwarded-access-token": "fake-token-1",
      "x-forwarded-email": "alice@example.com",
    });
    expect(bodies).toEqual(["request body"]);
    load.mockResolvedValue({ token: "fake-token-2", userId: "alice" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await (await fetch(origin(proxy))).text();
    expect(load).toHaveBeenCalledTimes(2);
    expect(received[1]["x-forwarded-access-token"]).toBe("fake-token-2");
    expect(received[1]["x-forwarded-email"]).toBeUndefined();
    load.mockRejectedValue(new Error("credential-bearing failure"));
    vi.spyOn(Date, "now").mockReturnValue(now + 62_000);
    const failed = await fetch(origin(proxy));
    expect(failed.status).toBe(401);
    expect(await failed.text()).not.toContain("credential-bearing");
    expect(received).toHaveLength(2);
  });

  test("rejects nonlocal targets and production before obtaining credentials", async () => {
    const loadIdentity = vi.fn();
    for (const target of [
      "https://example.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000/path",
      "http://user:pass@127.0.0.1:3000",
    ]) {
      await expect(
        startDevOboProxy({ target, port: 0, loadIdentity }),
      ).rejects.toThrow("loopback");
    }
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      startDevOboProxy({
        target: "http://127.0.0.1:3000",
        port: 0,
        loadIdentity,
      }),
    ).rejects.toThrow("disabled");
    expect(loadIdentity).not.toHaveBeenCalled();
  });

  test("rejects browser cross-origin and untrusted host requests", async () => {
    const upstream = vi.fn((_req, res) => res.end("ok"));
    const app = createServer(upstream);
    servers.push(app);
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const proxy = await startDevOboProxy({
      target: origin(app),
      port: 0,
      loadIdentity: async () => ({ token: "fake-token", userId: "alice" }),
    });
    servers.push(proxy);
    for (const headers of [
      { origin: "https://untrusted.example" },
      { host: "untrusted.example" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const outgoing = request(origin(proxy), { headers }, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          });
          outgoing.on("error", reject);
          outgoing.end();
        },
      );
      expect(status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
