import http, { type Server } from "node:http";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { FilesConnector } from "../../connectors/files/client";
import { createWorkspaceClient } from "../../workspace-client";
import { getClientOptions } from "../client-options";

/**
 * Wire-level attribution check. Everything else asserts against mocks; this
 * points a REAL `WorkspaceClient` (SDK path) and the REAL raw-`fetch` upload
 * connector at an in-process HTTP server and inspects the User-Agent that
 * actually leaves the process — the one contract mocks can't prove, since the
 * SDK is what turns `getClientOptions()` into the wire header.
 */
describe("User-Agent attribution (wire)", () => {
  let server: Server;
  let host: string;
  let capturedUserAgents: string[];

  const newClient = () =>
    createWorkspaceClient({
      host,
      token: "test-token",
      authType: "pat",
      clientOptions: getClientOptions(),
    });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      capturedUserAgents.push(req.headers["user-agent"] ?? "");
      req.resume(); // drain the body so the socket can complete
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server");
    }
    host = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    capturedUserAgents = [];
  });

  test("SDK apiClient.request() stamps the AppKit User-Agent on the wire", async () => {
    await newClient().apiClient.request({
      path: "/api/2.0/preview/scim/v2/Me",
      method: "GET",
      headers: new Headers(),
      raw: false,
    });

    expect(capturedUserAgents).toHaveLength(1);
    const ua = capturedUserAgents[0];
    // AppKit product first, and the real SDK segments after it — proving this
    // is the SDK-composed User-Agent, not a value a mock stubbed in.
    expect(ua).toMatch(/^@databricks\/appkit\/\d+\.\d+\.\d+ /);
    expect(ua).toContain("databricks-sdk-js/");
  });

  test("raw-fetch upload path stamps the AppKit User-Agent on the wire", async () => {
    const connector = new FilesConnector({});
    await connector.upload(
      newClient(),
      "/Volumes/catalog/schema/vol/wire-test.bin",
      "hello",
    );

    expect(capturedUserAgents).toHaveLength(1);
    expect(capturedUserAgents[0]).toMatch(
      /^@databricks\/appkit\/\d+\.\d+\.\d+/,
    );
  });

  test("dev mode adds the mode/dev User-Agent segment", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await newClient().apiClient.request({
        path: "/api/2.0/preview/scim/v2/Me",
        method: "GET",
        headers: new Headers(),
        raw: false,
      });
    } finally {
      process.env.NODE_ENV = prev;
    }

    expect(capturedUserAgents[0]).toContain("mode/dev");
  });
});
