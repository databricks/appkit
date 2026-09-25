import { Socket } from "node:net";

import { request, response, type Response } from "express";
import { loadDevOboIdentityFromEnvironment } from "shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDevOboMiddleware } from "../dev-obo-middleware";

vi.mock("shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("shared")>()),
  loadDevOboIdentityFromEnvironment: vi.fn(),
}));

function makeRequest() {
  const req = Object.create(request) as typeof request;
  req.headers = { host: "localhost:8000" };
  req.socket = new Socket();
  Object.defineProperties(req.socket, {
    remoteAddress: { value: "127.0.0.1", configurable: true },
    localPort: { value: 8000 },
  });
  return req;
}

async function invoke(req = makeRequest()) {
  const res = Object.create(response) as Response;
  const json = vi.fn(() => res);
  const status = vi.fn(() => res);
  res.json = json;
  res.status = status;
  const next = vi.fn();
  await createDevOboMiddleware()?.(req, res, next);
  return { req, status, json, next };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATABRICKS_CONFIG_PROFILE", "selected-user");
  vi.stubEnv("DATABRICKS_HOST", undefined);
  vi.stubEnv("DATABRICKS_TOKEN", undefined);
  vi.stubEnv("APPKIT_DEV_OBO", undefined);
  vi.mocked(loadDevOboIdentityFromEnvironment).mockResolvedValue({
    token: "fake-token",
    userId: "alice",
    email: "alice@example.com",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("automatic dev OBO middleware", () => {
  test("uses the configured profile and injects the complete caller identity", async () => {
    // Scaffolded local apps set an app name too.
    vi.stubEnv("DATABRICKS_APP_NAME", "local-app");
    const { req, next, status } = await invoke();
    expect(loadDevOboIdentityFromEnvironment).toHaveBeenCalledOnce();
    expect(req.headers).toMatchObject({
      "x-forwarded-access-token": "fake-token",
      "x-forwarded-user": "alice",
      "x-forwarded-email": "alice@example.com",
    });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  test.each(["production", "test", undefined])("is disabled in %s", (env) => {
    vi.stubEnv("NODE_ENV", env);
    expect(createDevOboMiddleware()).toBeUndefined();
    expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
  });

  test.each([undefined, "", " "])(
    "does not select a default profile when configured as %s",
    (profile) => {
      vi.stubEnv("DATABRICKS_CONFIG_PROFILE", profile);
      expect(createDevOboMiddleware()).toBeUndefined();
      expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
    },
  );

  test("enables injection with a token and host but no profile", async () => {
    vi.stubEnv("DATABRICKS_CONFIG_PROFILE", undefined);
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example");
    vi.stubEnv("DATABRICKS_TOKEN", "fake-direct-token");
    const { next } = await invoke();
    expect(next).toHaveBeenCalledOnce();
    expect(loadDevOboIdentityFromEnvironment).toHaveBeenCalledOnce();
  });

  test("can be disabled to use the existing development fallback", () => {
    vi.stubEnv("APPKIT_DEV_OBO", "false");
    expect(createDevOboMiddleware()).toBeUndefined();
    expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
  });

  test.each(["localhost:8000", "127.0.0.1:8000", "[::1]:8000"])(
    "accepts a same-origin request to %s",
    async (host) => {
      const req = makeRequest();
      req.headers = {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
      };
      const { next } = await invoke(req);
      expect(next).toHaveBeenCalledOnce();
    },
  );

  test.each([
    { host: "remote.example:8000" },
    { host: "localhost:9000" },
    { origin: "https://remote.example" },
    { origin: "http://localhost:9000" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ])(
    "does not load credentials for an untrusted request: %j",
    async (headers) => {
      const req = makeRequest();
      Object.assign(req.headers, headers);
      const { status, next } = await invoke(req);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
    },
  );

  test("does not use proxy headers to decide whether a client is local", async () => {
    const req = makeRequest();
    Object.defineProperty(req.socket, "remoteAddress", { value: "192.0.2.1" });
    req.headers["x-forwarded-for"] = "127.0.0.1";
    const { status, next } = await invoke(req);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
  });

  test("preserves explicitly forwarded credentials without loading the local profile", async () => {
    const req = makeRequest();
    req.headers = {
      host: "localhost:8000",
      origin: "http://127.0.0.1:3001",
      "x-forwarded-access-token": "forwarded-token",
      "x-forwarded-user": "bob",
      "x-forwarded-email": "bob@example.com",
    };
    const expected = { ...req.headers };
    const { next } = await invoke(req);
    expect(next).toHaveBeenCalledOnce();
    expect(req.headers).toEqual(expected);
    expect(loadDevOboIdentityFromEnvironment).not.toHaveBeenCalled();
  });

  test("clears an unrelated email when the resolved identity has none", async () => {
    vi.mocked(loadDevOboIdentityFromEnvironment).mockResolvedValue({
      token: "fake-token",
      userId: "alice",
    });
    const req = makeRequest();
    req.headers["x-forwarded-email"] = "unrelated@example.com";
    await invoke(req);
    expect(req.headers["x-forwarded-email"]).toBeUndefined();
  });

  test("fails closed without exposing the CLI error or continuing as SP", async () => {
    vi.mocked(loadDevOboIdentityFromEnvironment).mockRejectedValue(
      new Error("credential-bearing failure"),
    );
    const { req, status, json, next } = await invoke();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: expect.stringContaining("DATABRICKS_TOKEN"),
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("credential-bearing");
    expect(req.headers["x-forwarded-access-token"]).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });
});
