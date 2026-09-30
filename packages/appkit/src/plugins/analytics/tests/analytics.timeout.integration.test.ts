import { createServer } from "node:http";

import { expect, test, vi } from "vitest";

import { AppManager } from "../../../app";
import {
  createTestApp,
  createSuccessfulSQLResponse,
  getListeningPort,
  getMock,
} from "../../../testing";
import { createWorkspaceClient } from "../../../workspace-client";
import { analytics } from "../index";

test("a real SDK cancellation becomes a terminal TIMEOUT event on HTTP 200", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;
  const upstream = createServer((_req, res) => {
    requests++;
    timer = setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          createSuccessfulSQLResponse([["ok"]], [{ name: "value" }]),
        ),
      );
    }, 2000);
  });
  upstream.listen(0, "127.0.0.1");
  const port = await getListeningPort(upstream);
  // Explicit loopback host and dummy PAT keep every SDK request local.
  const sdk = createWorkspaceClient({
    host: `http://127.0.0.1:${port}`,
    token: "local-test-only",
  });
  const query = vi
    .spyOn(AppManager.prototype, "getAppQuery")
    .mockResolvedValue({ query: "SELECT 1", isAsUser: false });
  const app = await createTestApp({ plugins: [analytics({ timeout: 250 })] });
  try {
    const execute = getMock(app.client, "statementExecution.executeStatement");
    execute.mockImplementation((input, context) =>
      sdk.statementExecution.executeStatement(input, context),
    );
    const response = await app.post("/api/analytics/query/timeout_regression", {
      body: { parameters: {}, format: "JSON_ARRAY" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(requests).toBe(1);
    expect(body.match(/event: error/g)).toHaveLength(1);
    expect(body).toContain('"code":"TIMEOUT"');
    expect(body).toContain('"error":"Query timed out, please try again"');
    expect(body).not.toContain("event: result");
    expect(body).not.toContain("The operation was aborted.");
  } finally {
    await app.close();
    query.mockRestore();
    clearTimeout(timer);
    const closed = new Promise<void>((resolve) =>
      upstream.close(() => resolve()),
    );
    upstream.closeAllConnections();
    await closed;
  }
}, 10000);
