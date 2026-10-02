import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  setupDatabricksEnv,
  useServiceContextMock,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../context/service-context";
import { GeniePlugin } from "../genie/genie";
import { ServingPlugin } from "../serving/serving";

// Regression for the deprecated-asUser warning on core-plugin OBO routes.
// genie and serving route handlers must scope via the internal
// `_asUserScoped(req)`, never the public `Plugin.asUser(req)`, so exercising
// an OBO route emits no "Plugin.asUser is deprecated" warning. This is the
// not-emitted complement to the emitted-case assertion in
// core/tests/appkit-user-scope.test.ts. It lives in its own file so the
// deprecation warn-once dedup starts fresh and cannot mask a regression.
describe("core plugin OBO routes do not warn about deprecated asUser", () => {
  useServiceContextMock();

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    setupDatabricksEnv();
    ServiceContext.reset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ServiceContext.reset();
  });

  const oboReq = (params: Record<string, string>) =>
    createMockRequest({
      params,
      body: { content: "hi", input: "hi" },
      headers: {
        "x-forwarded-access-token": "user-token",
        "x-forwarded-user": "user-1",
      },
    });

  const deprecationWarnings = () =>
    warn.mock.calls.filter((args) =>
      args.some(
        (a) =>
          typeof a === "string" && a.includes("Plugin.asUser is deprecated"),
      ),
    );

  test("genie sendMessage route scopes without the deprecation warning", async () => {
    const plugin = new GeniePlugin({ spaces: { myspace: "space-123" } });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/:alias/messages");

    // Unknown alias returns 404 inside the handler, but only after the route
    // wrapper has already scoped via _asUserScoped(req), which is the line
    // under test.
    await handler(oboReq({ alias: "unknown" }), createMockResponse());

    expect(deprecationWarnings()).toHaveLength(0);
  });

  test("serving invoke route scopes without the deprecation warning", async () => {
    const plugin = new ServingPlugin({
      endpoints: { llm: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } },
    });
    const { router, getHandler } = createMockRouter();
    plugin.injectRoutes(router);
    const handler = getHandler("POST", "/:alias/invoke");

    await handler(oboReq({ alias: "unknown" }), createMockResponse());

    expect(deprecationWarnings()).toHaveLength(0);
  });
});
