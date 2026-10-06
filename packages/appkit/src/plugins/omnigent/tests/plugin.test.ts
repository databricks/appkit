import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
  mockServiceContext,
  setupDatabricksEnv,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceContext } from "../../../context/service-context";
import { OmnigentPlugin } from "../omnigent";

function plugin() {
  const p = new OmnigentPlugin({});
  const { router, getHandler } = createMockRouter();
  p.injectRoutes(router);
  return { p, getHandler };
}

async function call(
  handler: (req: unknown, res: unknown) => Promise<void>,
  req: object,
) {
  const res = createMockResponse();
  await handler(createMockRequest(req), res);
  return res;
}

describe("OmnigentPlugin routes", () => {
  let ctx: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    ctx = await mockServiceContext({});
  });

  afterEach(() => {
    ctx?.restore();
    vi.restoreAllMocks();
  });

  test("registers the session API", () => {
    const { getHandler } = plugin();
    for (const [m, path] of [
      ["GET", "/status"],
      ["GET", "/harnesses"],
      ["GET", "/sessions"],
      ["POST", "/sessions"],
      ["GET", "/sessions/:id"],
      ["DELETE", "/sessions/:id"],
      ["POST", "/sessions/:id/messages"],
      ["POST", "/sessions/:id/interrupt"],
      ["GET", "/sessions/:id/stream"],
    ]) {
      expect(getHandler(m, path), `${m} ${path}`).toBeTypeOf("function");
    }
  });

  test("session routes need a forwarded identity", async () => {
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), {});
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test("a signed-in request before the runtime starts gets 503, not a crash", async () => {
    const { getHandler } = plugin();
    const res = await call(getHandler("GET", "/sessions"), {
      obo: { token: "t", userId: "u", email: "a@example.com" },
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
