import type { Server } from "node:http";

import type { Router } from "express";
import getPort from "get-port";
import { loadDevOboIdentityFromEnvironment } from "shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { getCurrentPrincipalKey } from "../../../context/execution-context";
import { createRequestScope } from "../../../context/request-scope";
import { AppKit, disposeApp } from "../../../core/appkit";
import { Plugin, toPlugin } from "../../../plugin";
import { defineManifest } from "../../../registry";
import { getListeningPort, mockServiceContext } from "../../../testing";
import { server } from "../index";

vi.mock("shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("shared")>()),
  loadDevOboIdentityFromEnvironment: vi.fn(),
}));
vi.mock("../vite-dev-server", () => ({
  ViteDevServer: class {
    async setup() {}
    async close() {}
  },
}));

class IdentityProbe extends Plugin {
  static manifest = defineManifest<"identityProbe">({
    name: "identityProbe",
    displayName: "Identity probe",
    version: "1.0.0",
    description: "Local execution identity test",
    resources: { required: [], optional: [] },
  });

  injectRoutes(router: Router) {
    router.get("/user", (req, res) => {
      createRequestScope(req).run(() => {
        res.json({ principal: getCurrentPrincipalKey() });
      });
    });
    router.get("/app", (_req, res) => {
      res.json({ principal: getCurrentPrincipalKey() });
    });
  }
}

describe("normal dev server OBO injection", () => {
  let baseUrl: string;
  let httpServer: Server;
  let dispose: () => Promise<void>;
  let service: ReturnType<typeof mockServiceContext>;
  let now = Date.now();

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABRICKS_CONFIG_PROFILE", "selected-user");
    vi.stubEnv("DATABRICKS_TOKEN", undefined);
    vi.stubEnv("DATABRICKS_APP_NAME", "scaffolded-local-app");
    vi.stubEnv("APPKIT_DEV_OBO", undefined);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(loadDevOboIdentityFromEnvironment).mockResolvedValue({
      token: "fake-user-token",
      userId: "alice",
      email: "alice@example.com",
    });
    service = mockServiceContext();
    const kit = await AppKit._createApp({
      plugins: [
        server({
          port: await getPort({ host: "127.0.0.1" }),
          host: "127.0.0.1",
        }),
        toPlugin(IdentityProbe)({}),
      ],
      installSignalHandlers: false,
      disableInternalTelemetry: true,
      onPluginsReady(appkit) {
        appkit.server.extend((app) => {
          app.get("/custom-user", (req, res, next) => {
            void appkit
              .asUser(req)
              .run(() => {
                res.json({ principal: getCurrentPrincipalKey() });
              })
              .catch(next);
          });
        });
      },
    });
    if (!(kit instanceof AppKit)) throw new Error("Expected AppKit");
    dispose = () => kit[disposeApp]();
    httpServer = kit.server.getServer();
    baseUrl = `http://127.0.0.1:${await getListeningPort(httpServer)}`;
  });

  afterAll(async () => {
    await dispose?.();
    service?.restore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("plugin routes run as the user without a proxy or manually supplied headers", async () => {
    const response = await fetch(`${baseUrl}/api/identity-probe/user`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: "user:alice" });
    expect(service.createUserContextSpy).toHaveBeenCalledWith(
      "fake-user-token",
      "alice",
      undefined,
      "alice@example.com",
    );
    expect(loadDevOboIdentityFromEnvironment).toHaveBeenCalledOnce();
  });

  test("custom appkit.asUser routes get the same automatic headers", async () => {
    const response = await fetch(`${baseUrl}/custom-user`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: "user:alice" });
  });

  test("unscoped routes remain app-scoped despite the injected user headers", async () => {
    const response = await fetch(`${baseUrl}/api/identity-probe/app`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: "app" });
  });

  test("refresh failure rejects and recovery never falls back to SP", async () => {
    now += 31_000;
    vi.mocked(loadDevOboIdentityFromEnvironment).mockRejectedValue(
      new Error("credential-bearing failure"),
    );
    const failed = await fetch(`${baseUrl}/api/identity-probe/user`);
    expect(failed.status).toBe(401);
    expect(await failed.text()).not.toContain("credential-bearing");

    vi.mocked(loadDevOboIdentityFromEnvironment).mockResolvedValue({
      token: "refreshed-token",
      userId: "alice",
    });
    const recovered = await fetch(`${baseUrl}/api/identity-probe/user`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ principal: "user:alice" });
    expect(service.createUserContextSpy).toHaveBeenLastCalledWith(
      "refreshed-token",
      "alice",
      undefined,
      undefined,
    );
  });
});
