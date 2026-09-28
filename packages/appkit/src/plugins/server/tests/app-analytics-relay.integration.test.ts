import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";

import { createAppAnalytics } from "@databricks/app-analytics";
import {
  getListeningPort,
  mockServiceContext,
  setupDatabricksEnv,
} from "@databricks/appkit/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { ServiceContext } from "../../../context/service-context";
import { createApp } from "../../../core";
import { APP_ANALYTICS_PATH } from "../app-analytics-relay";
import { server as serverPlugin } from "../index";

interface CollectorRequest {
  body: string;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  path: string | undefined;
}

interface FakeCollector {
  /** OTLP logs endpoint, as `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` would carry it. */
  endpoint: string;
  requests: CollectorRequest[];
  status: number;
  close(): Promise<void>;
}

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

describe("App Analytics relay (integration)", () => {
  const originalEnv = Object.fromEntries(
    OTEL_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  let appServer: Server;
  let baseUrl: string;
  let collector: FakeCollector;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeAll(async () => {
    // Keep AppKit's own TelemetryManager off: it only starts when
    // OTEL_EXPORTER_OTLP_ENDPOINT is set, while the relay also honours the
    // logs-specific endpoint the tests point at the fake collector.
    for (const key of OTEL_ENV_KEYS) delete process.env[key];

    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
    collector = await startFakeCollector();

    const app = await createApp({
      disableInternalTelemetry: true,
      plugins: [serverPlugin({ port: 0, host: "127.0.0.1" })],
    });
    appServer = app.server.getServer();
    baseUrl = `http://127.0.0.1:${await getListeningPort(appServer)}`;
  });

  beforeEach(() => {
    collector.requests.length = 0;
    collector.status = 200;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = collector.endpoint;
  });

  afterAll(async () => {
    if (appServer) {
      appServer.closeAllConnections();
      await closeServer(appServer);
    }
    await collector?.close();
    serviceContextMock?.restore();
    for (const key of OTEL_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("relays an SDK batch to the collector unchanged", async () => {
    const [browser] = await sendSdkEvents(baseUrl, (client) => {
      client.track("report_exported", { format: "csv", rows: 1240 });
    });

    expect(browser.status).toBe(200);
    expect(collector.requests).toHaveLength(1);
    const [forwarded] = collector.requests;
    expect(forwarded).toMatchObject({
      method: "POST",
      path: "/v1/logs",
      body: browser.body,
    });
    expect(forwarded.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(forwarded.body);
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record).toMatchObject({
      eventName: "report_exported",
      severityText: "INFO",
      severityNumber: 9,
    });
    expect(JSON.parse(record.body.stringValue)).toEqual({
      schema_version: 1,
      event_id: expect.any(String),
      event_type: "action",
      event_name: "report_exported",
      session_id: expect.any(String),
      properties: { format: "csv", rows: 1240 },
    });
  });

  test("accepts the largest batches the SDK builds", async () => {
    // Each event is about 4 KiB once encoded, so the SDK splits these into
    // batches close to its byte cap. If that cap ever grows past the relay's
    // limit, the relay answers 413 here.
    const requests = await sendSdkEvents(baseUrl, (client) => {
      for (let index = 0; index < 30; index += 1) {
        client.track("report_exported", {
          first: "x".repeat(1_000),
          second: "y".repeat(1_000),
        });
      }
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map(({ status }) => status)).toEqual(
      requests.map(() => 200),
    );
    expect(
      Math.max(...requests.map(({ body }) => Buffer.byteLength(body))),
    ).toBeGreaterThan(40 * 1024);
    expect(collector.requests.map(({ body }) => body)).toEqual(
      requests.map(({ body }) => body),
    );
  });

  test("answers with the collector's status and an empty body", async () => {
    collector.status = 429;

    const response = await postLogs(baseUrl, { resourceLogs: [] });

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("");
    expect(collector.requests).toHaveLength(1);
  });

  test("answers 502 when the collector can't be reached", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:1/v1/logs";

    const response = await postLogs(baseUrl, { resourceLogs: [] });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
  });

  test("answers 204 and forwards nothing when App telemetry is off", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;

    const response = await postLogs(baseUrl, { resourceLogs: [] });

    expect(response.status).toBe(204);
    expect(collector.requests).toHaveLength(0);
  });

  test("answers 413 for a body over 64 KiB, within the global 1 MB limit", async () => {
    const response = await postLogs(baseUrl, {
      resourceLogs: [],
      padding: "x".repeat(64 * 1024),
    });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(collector.requests).toHaveLength(0);
  });

  test("answers 415 for a body that isn't JSON", async () => {
    const response = await fetch(`${baseUrl}${APP_ANALYTICS_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ resourceLogs: [] }),
    });

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("");
    expect(collector.requests).toHaveLength(0);
  });

  test.each([
    ["malformed JSON", '{"resourceLogs":'],
    ["a body without resourceLogs", "{}"],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await fetch(`${baseUrl}${APP_ANALYTICS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(collector.requests).toHaveLength(0);
  });
});

describe("App Analytics relay turned off (integration)", () => {
  let appServer: Server;
  let baseUrl: string;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeAll(async () => {
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    const app = await createApp({
      disableInternalTelemetry: true,
      plugins: [
        serverPlugin({ port: 0, host: "127.0.0.1", appAnalytics: false }),
      ],
    });
    appServer = app.server.getServer();
    baseUrl = `http://127.0.0.1:${await getListeningPort(appServer)}`;
  });

  afterAll(async () => {
    if (appServer) {
      appServer.closeAllConnections();
      await closeServer(appServer);
    }
    serviceContextMock?.restore();
  });

  test("server({ appAnalytics: false }) removes the route", async () => {
    const response = await postLogs(baseUrl, { resourceLogs: [] });

    expect(response.status).toBe(404);
  });
});

function postLogs(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${APP_ANALYTICS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Drives a real App Analytics client and returns every request it made.
 * Outside a browser the SDK posts to its default relative endpoint, so
 * `fetch` is stubbed to send those requests to the app server; every other
 * request, including the relay's own forward to the collector, goes through
 * the native `fetch`.
 */
async function sendSdkEvents(
  baseUrl: string,
  record: (client: ReturnType<typeof createAppAnalytics>) => void,
): Promise<Array<{ body: string; status: number }>> {
  const nativeFetch = globalThis.fetch;
  const requests: Array<{ body: string; status: number }> = [];
  const routeFetch: typeof globalThis.fetch = async (input, init) => {
    if (input !== APP_ANALYTICS_PATH) return nativeFetch(input, init);

    const response = await nativeFetch(`${baseUrl}${APP_ANALYTICS_PATH}`, init);
    requests.push({ body: String(init?.body), status: response.status });
    return response;
  };
  vi.stubGlobal("fetch", routeFetch);

  try {
    const client = createAppAnalytics();
    client.init({ automaticPageViews: false });
    record(client);
    await client.flush();
    await client.shutdown();
  } finally {
    vi.unstubAllGlobals();
  }

  if (requests.length === 0) throw new Error("SDK did not send a request");
  return requests;
}

async function startFakeCollector(): Promise<FakeCollector> {
  const requests: CollectorRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push({
      body: await readBody(request),
      headers: request.headers,
      method: request.method,
      path: request.url,
    });
    response.writeHead(collector.status).end();
  });
  const collector: FakeCollector = {
    endpoint: "",
    requests,
    status: 200,
    async close() {
      server.closeAllConnections();
      await closeServer(server);
    },
  };

  server.listen(0, "127.0.0.1");
  collector.endpoint = `http://127.0.0.1:${await getListeningPort(server)}/v1/logs`;
  return collector;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
