import {
  createTestApp,
  expectStream,
  getMockFn,
} from "@databricks/appkit/testing";
import { describe, expect, test } from "vitest";

import { Plugin, toPlugin } from "../../plugin";

/**
 * The acceptance test for the whole published surface.
 *
 * Everything the *test* needs comes from `@databricks/appkit/testing` and
 * nothing else — no `@tools/test-helpers` shim, no deep import of
 * `../context/service-context` to reach a reset. If a plugin author outside this
 * repo can write this file, the surface is self-sufficient.
 *
 * `Plugin`/`toPlugin` are imported from the main entry because they are how you
 * *write* a plugin, not how you test one; an external author gets them from
 * `@databricks/appkit`.
 */

class WidgetPlugin extends Plugin {
  static manifest = {
    name: "widget",
    displayName: "Widget",
    version: "0.0.0",
    description: "A plugin an external author might write",
    resources: { required: [], optional: [] },
  } as never;

  injectRoutes(router: never): void {
    this.route(router, {
      name: "run",
      method: "post",
      path: "/run",
      handler: async (req, res) => {
        // The data plane, faked by the harness with no workspace in sight.
        const { getWorkspaceClient } = await import("../../context");
        const run = await getWorkspaceClient().jobs.getRun({
          run_id: (req.body as { id: number }).id,
        } as never);
        res.json({ run });
      },
    });

    this.route(router, {
      name: "stream",
      method: "post",
      path: "/stream",
      handler: async (_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.write(`event: status\ndata: ${JSON.stringify({ s: "go" })}\n\n`);
        res.write(`event: result\ndata: ${JSON.stringify({ n: 1 })}\n\n`);
        res.end();
      },
    });
  }
}
const widget = toPlugin(WidgetPlugin);

describe("@databricks/appkit/testing as a standalone surface", () => {
  test("boot, request, assert a stream, and close — public imports only", async () => {
    const app = await createTestApp({
      plugins: [widget()],
      responses: { "jobs.getRun": { state: "TERMINATED" } },
    });

    try {
      const res = await app.post("/api/widget/run", { body: { id: 42 } });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        run: { state: "TERMINATED" },
      });
      expect(getMockFn(app.client, "jobs.getRun")).toHaveBeenCalledWith({
        run_id: 42,
      });

      const stream = await app.post("/api/widget/stream");
      await expectStream(stream).toEmit("status", "result");
    } finally {
      await app.close();
    }
  });

  test("await using works from the public entry too", async () => {
    let port: number | undefined;
    {
      await using app = await createTestApp({ plugins: [widget()] });
      port = app.port;
      const res = await app.post("/api/widget/run", { body: { id: 1 } });
      expect(res.status).toBe(200);
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
