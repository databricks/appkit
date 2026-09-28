import fs from "node:fs";
import http, {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import os from "node:os";
import path from "node:path";

import { getListeningPort } from "@databricks/appkit/testing";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { isTracingSuppressed } from "@opentelemetry/core";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { resolveOtlpLogsExport } from "../../../telemetry/otlp-logs-export";
import {
  APP_ANALYTICS_PATH,
  APP_ANALYTICS_SDK_PATH,
  type AppAnalyticsRelayOptions,
  appAnalyticsBrowserOptions,
  createAppAnalyticsRelay,
  forwardOtlpLogs,
  resolveOtlpLogsEndpoint,
  serveSdk,
  shouldInjectSdk,
} from "../app-analytics-relay";

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  event: vi.fn(),
}));

vi.mock("../../../logging/logger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../logging/logger")>();
  return { ...actual, createLogger: () => loggerSpies };
});

const payload = {
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [
        {
          scope: { name: "@databricks/app-analytics", version: "0.1.0" },
          logRecords: [{ eventName: "report_exported", attributes: [] }],
        },
      ],
    },
  ],
};

/** OTLP logs JSON with `count` minimal records in one scope. */
function logsWithRecords(count: number): string {
  return JSON.stringify({
    resourceLogs: [
      {
        scopeLogs: [{ logRecords: Array.from({ length: count }, () => ({})) }],
      },
    ],
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

interface CollectorAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface FakeCollector {
  url: string;
  requests: Array<{ body: string; headers: IncomingMessage["headers"] }>;
  /** Answer for the next requests. */
  answer: CollectorAnswer;
  /** When set, requests wait for it before being answered. */
  hold: Promise<void> | undefined;
  close(): Promise<void>;
}

async function startFakeCollector(): Promise<FakeCollector> {
  const collector: FakeCollector = {
    url: "",
    requests: [],
    answer: { status: 200 },
    hold: undefined,
    close: async () => closeServer(server),
  };
  const server = createServer(async (request, response) => {
    collector.requests.push({
      body: await readBody(request),
      headers: request.headers,
    });
    await collector.hold;
    const { status, headers = {}, body } = collector.answer;
    response.writeHead(status, headers).end(body);
  });
  server.listen(0, "127.0.0.1");
  collector.url = `http://127.0.0.1:${await getListeningPort(server)}/v1/logs`;
  return collector;
}

describe("resolveOtlpLogsExport", () => {
  test("appends the standard logs path to the shared endpoint", () => {
    expect(
      resolveOtlpLogsExport({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314",
      }),
    ).toEqual({ url: "http://localhost:4314/v1/logs", headers: {} });
  });

  test("strips a trailing slash from the shared endpoint", () => {
    expect(
      resolveOtlpLogsEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314/",
      }),
    ).toBe("http://localhost:4314/v1/logs");
  });

  test("uses a signal-specific endpoint as-is", () => {
    expect(
      resolveOtlpLogsEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4315/custom/logs",
      }),
    ).toBe("http://localhost:4315/custom/logs");
  });

  test("reads OTLP headers, logs-specific ones winning per key", () => {
    expect(
      resolveOtlpLogsExport({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20shared,x-team=a",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer%20logs",
      })?.headers,
    ).toEqual({ authorization: "Bearer logs", "x-team": "a" });
  });

  test("returns undefined when App telemetry is off", () => {
    expect(resolveOtlpLogsExport({})).toBeUndefined();
    expect(
      resolveOtlpLogsExport({
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=token",
      }),
    ).toBeUndefined();
  });

  test("reads process.env by default", () => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "http://127.0.0.1:4318/logs",
    );
    try {
      expect(resolveOtlpLogsEndpoint()).toBe("http://127.0.0.1:4318/logs");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("forwardOtlpLogs", () => {
  const target = { url: "http://localhost:4314/v1/logs", headers: {} };
  const body = Buffer.from(JSON.stringify(payload));
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    context.disable();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(answer: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => answer(),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("posts the bytes as JSON, with the OTLP headers, without following redirects", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await forwardOtlpLogs(body, {
      ...target,
      headers: { authorization: "Bearer token" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe(target.url);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body,
      redirect: "manual",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  test("creates no span for the forward", async () => {
    let suppressed: boolean | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        suppressed = isTracingSuppressed(context.active());
        return new Response(null, { status: 200 });
      }),
    );

    await forwardOtlpLogs(body, target);

    expect(suppressed).toBe(true);
  });

  test("accepts an HTTP-date Retry-After", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 503,
          headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
        }),
    );

    await expect(forwardOtlpLogs(body, target)).resolves.toEqual({
      status: 503,
      retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
  });

  test("returns the status, a valid Retry-After, and the rejected record count", async () => {
    stubFetch(
      () =>
        new Response('{"partialSuccess":{"rejectedLogRecords":"3"}}', {
          status: 200,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
    );

    await expect(forwardOtlpLogs(body, target)).resolves.toEqual({
      status: 200,
      retryAfter: "7",
      rejectedLogRecords: 3,
    });
  });

  test.each(["soon", "", "-1", "1.5", "2015-10-21T07:28:00Z"])(
    "ignores an invalid Retry-After: %j",
    async (retryAfter) => {
      stubFetch(
        () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
      );

      await expect(forwardOtlpLogs(body, target)).resolves.toEqual({
        status: 429,
      });
    },
  );

  test("releases a large or non-JSON answer without reading it all", async () => {
    const response = new Response("x".repeat(100_000), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const bodyStream = response.body;
    if (bodyStream === null) throw new Error("Expected a response body");
    stubFetch(() => response);

    await expect(forwardOtlpLogs(body, target)).resolves.toEqual({
      status: 200,
    });
    expect(bodyStream.locked).toBe(true);
    await expect(response.text()).rejects.toThrow();
  });

  test("rejects when the collector can't be reached", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(forwardOtlpLogs(body, target)).rejects.toThrow("fetch failed");
  });
});

describe("createAppAnalyticsRelay", () => {
  let collector: FakeCollector;
  let appServer: Server | undefined;
  let baseUrl: string;
  let clock: number;
  let relay: ReturnType<typeof createAppAnalyticsRelay>;
  const counter = { add: vi.fn() };
  const telemetry = {
    getMeter: () => ({ createCounter: () => counter }) as never,
  };
  const reachedLaterRoute = vi.fn();
  const errorHandler = vi.fn();

  beforeAll(async () => {
    collector = await startFakeCollector();
  });

  afterAll(async () => {
    await collector.close();
  });

  beforeEach(() => {
    collector.requests.length = 0;
    collector.answer = { status: 200 };
    collector.hold = undefined;
    clock = 0;
  });

  afterEach(async () => {
    if (appServer) await closeServer(appServer);
    appServer = undefined;
    vi.clearAllMocks();
  });

  /** Mounts a relay on a bare Express app, as the server plugin does. */
  async function startRelay(
    options: Partial<AppAnalyticsRelayOptions> = {},
  ): Promise<void> {
    relay = createAppAnalyticsRelay({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.url },
      telemetry,
      now: () => clock,
      ...options,
    });
    const app = express();
    app.post(APP_ANALYTICS_PATH, ...relay.handlers);
    app.use((_req, res) => {
      reachedLaterRoute();
      res.status(404).end();
    });
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        errorHandler(error);
        res.status(500).end();
      },
    );
    appServer = app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${await getListeningPort(appServer)}`;
  }

  function post(
    body: string | Buffer,
    contentType = "application/json",
    path = APP_ANALYTICS_PATH,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  function outcomes(): unknown[] {
    return counter.add.mock.calls.map(([, attributes]) => attributes);
  }

  async function expectAnswer(
    response: Response,
    status: number,
    outcome: string,
  ): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(outcomes()).toContainEqual({
      outcome,
      "http.response.status_code": status,
    });
  }

  describe("request checks", () => {
    beforeEach(() => startRelay());

    async function expectInvalid(response: Response, status: number) {
      await expectAnswer(response, status, "invalid");
      expect(collector.requests).toHaveLength(0);
      expect(errorHandler).not.toHaveBeenCalled();
    }

    test("forwards the body byte for byte, without incoming headers", async () => {
      const body = ` {"resourceLogs":[{"scopeLogs":[{"logRecords":[{"n":1.10}]}]}],"b":1,"b":2} `;
      const response = await fetch(`${baseUrl}${APP_ANALYTICS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=secret",
          "x-forwarded-access-token": "user-token",
        },
        body,
      });

      await expectAnswer(response, 200, "forwarded");
      expect(collector.requests).toHaveLength(1);
      expect(collector.requests[0].body).toBe(body);
      expect(collector.requests[0].headers.cookie).toBeUndefined();
      expect(
        collector.requests[0].headers["x-forwarded-access-token"],
      ).toBeUndefined();
    });

    test("accepts a JSON content type with a UTF-8 charset", async () => {
      const response = await post(
        JSON.stringify(payload),
        "application/json; charset=UTF-8",
      );

      expect(response.status).toBe(200);
    });

    test("forwards a body with a byte order mark without it", async () => {
      const json = JSON.stringify(payload);
      const response = await post(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
      );

      expect(response.status).toBe(200);
      expect(collector.requests[0].body).toBe(json);
    });

    test.each(["text/plain", "application/x-www-form-urlencoded"])(
      "answers 415 for %s",
      async (contentType) => {
        await expectInvalid(
          await post(JSON.stringify(payload), contentType),
          415,
        );
      },
    );

    test("answers 415 for a charset other than UTF-8", async () => {
      await expectInvalid(
        await post(JSON.stringify(payload), "application/json; charset=latin1"),
        415,
      );
    });

    test("answers 413 when the body is over 64 KiB", async () => {
      const body = JSON.stringify({
        resourceLogs: [],
        padding: "x".repeat(64 * 1024),
      });

      await expectInvalid(await post(body), 413);
    });

    test("accepts 100 records", async () => {
      expect((await post(logsWithRecords(100))).status).toBe(200);
    });

    test("answers 413 for 101 records", async () => {
      await expectInvalid(await post(logsWithRecords(101)), 413);
    });

    test.each([
      ["not JSON", '{"resourceLogs":'],
      ["empty", ""],
      ["an array", "[]"],
      ["without resourceLogs", "{}"],
      ["resourceLogs that isn't an array", '{"resourceLogs":{}}'],
      ["a resourceLogs entry that isn't an object", '{"resourceLogs":[[]]}'],
      ["scopeLogs that isn't an array", '{"resourceLogs":[{"scopeLogs":{}}]}'],
      [
        "logRecords that isn't an array",
        '{"resourceLogs":[{"scopeLogs":[{"logRecords":"x"}]}]}',
      ],
      [
        "a log record that isn't an object",
        '{"resourceLogs":[{"scopeLogs":[{"logRecords":[1]}]}]}',
      ],
    ])("answers 400 for a body that is %s", async (_case, body) => {
      await expectInvalid(await post(body), 400);
    });

    test("answers 400 for deeply nested JSON without calling it a collector failure", async () => {
      const depth = 30_000;
      const body = `{"resourceLogs":[${"[".repeat(depth)}${"]".repeat(depth)}]}`;

      await expectInvalid(await post(body), 400);
      expect(loggerSpies.warn).not.toHaveBeenCalled();
    });

    test.each([`${APP_ANALYTICS_PATH}/`, APP_ANALYTICS_PATH.toUpperCase()])(
      "leaves %s to later routes",
      async (path) => {
        const response = await post(JSON.stringify(payload), undefined, path);

        expect(response.status).toBe(404);
        expect(reachedLaterRoute).toHaveBeenCalledOnce();
        expect(collector.requests).toHaveLength(0);
      },
    );
  });

  describe("collector answers", () => {
    beforeEach(() => startRelay());

    test.each([
      [200, 200, "forwarded"],
      [202, 202, "forwarded"],
      [400, 400, "rejected"],
      [413, 413, "rejected"],
      [408, 408, "throttled"],
      [429, 429, "throttled"],
      [500, 500, "collector_error"],
      [503, 503, "collector_error"],
      [302, 502, "misconfigured"],
      [401, 502, "misconfigured"],
      [403, 502, "misconfigured"],
      [404, 502, "misconfigured"],
    ])(
      "answers a collector %i with %i (%s)",
      async (collectorStatus, status, outcome) => {
        collector.answer = {
          status: collectorStatus,
          headers: { location: "http://example.com/" },
          body: "collector details",
        };

        await expectAnswer(
          await post(JSON.stringify(payload)),
          status,
          outcome,
        );
      },
    );

    test.each([429, 503])(
      "passes the collector's Retry-After on with %i",
      async (status) => {
        collector.answer = { status, headers: { "retry-after": "7" } };

        const response = await post(JSON.stringify(payload));

        expect(response.status).toBe(status);
        expect(response.headers.get("retry-after")).toBe("7");
      },
    );

    test("doesn't pass Retry-After on with other statuses", async () => {
      collector.answer = { status: 500, headers: { "retry-after": "7" } };

      const response = await post(JSON.stringify(payload));

      expect(response.headers.get("retry-after")).toBeNull();
    });

    test("warns when the collector rejects part of an accepted request", async () => {
      collector.answer = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"partialSuccess":{"rejectedLogRecords":"2"}}',
      };

      await expectAnswer(
        await post(JSON.stringify(payload)),
        200,
        "partially_rejected",
      );
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("rejected %d App Analytics records"),
        collector.url,
        2,
      );
    });

    test("answers 502 and warns when the collector can't be reached", async () => {
      await closeServer(appServer as Server);
      await startRelay({
        env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:1/v1/logs" },
      });

      await expectAnswer(
        await post(JSON.stringify(payload)),
        502,
        "unreachable",
      );
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not reach the OTel Collector"),
        "http://127.0.0.1:1/v1/logs",
        expect.stringContaining("fetch failed"),
      );
    });

    test("logs the collector endpoint without credentials or a query string", async () => {
      await closeServer(appServer as Server);
      const url = new URL(collector.url);
      url.username = "user";
      url.password = "secret";
      url.search = "?token=secret";
      await startRelay({
        env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: url.href },
      });
      collector.answer = { status: 500 };

      await post(JSON.stringify(payload));

      expect(loggerSpies.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(loggerSpies.warn.mock.calls[0])).not.toContain(
        "secret",
      );
    });
  });

  describe("collector warnings", () => {
    beforeEach(() => startRelay());

    test("logs a failing collector at most once a minute, with a count of the rest", async () => {
      collector.answer = { status: 503 };

      await post(JSON.stringify(payload));
      await post(JSON.stringify(payload));
      await post(JSON.stringify(payload));
      expect(loggerSpies.warn).toHaveBeenCalledOnce();

      clock += 60_000;
      await post(JSON.stringify(payload));

      expect(loggerSpies.warn).toHaveBeenCalledTimes(2);
      expect(loggerSpies.warn.mock.calls[1]).toEqual([
        expect.stringContaining("%d similar warnings"),
        collector.url,
        503,
        2,
      ]);
    });

    test("logs the recovery and the next failure right away", async () => {
      collector.answer = { status: 503 };
      await post(JSON.stringify(payload));

      collector.answer = { status: 200 };
      await post(JSON.stringify(payload));
      expect(loggerSpies.info).toHaveBeenCalledWith(
        expect.stringContaining("accepts App Analytics records again"),
        collector.url,
      );

      collector.answer = { status: 503 };
      await post(JSON.stringify(payload));
      expect(loggerSpies.warn).toHaveBeenCalledTimes(2);
    });

    test("doesn't log a healthy collector", async () => {
      await post(JSON.stringify(payload));

      expect(loggerSpies.warn).not.toHaveBeenCalled();
      expect(loggerSpies.info).not.toHaveBeenCalled();
    });
  });

  describe("telemetry off", () => {
    test("answers 204, forwards nothing, and warns once", async () => {
      await startRelay({ env: {} });

      await expectAnswer(await post(JSON.stringify(payload)), 204, "discarded");
      await post(JSON.stringify(payload));

      expect(collector.requests).toHaveLength(0);
      expect(loggerSpies.warn).toHaveBeenCalledOnce();
      expect(loggerSpies.warn.mock.calls[0]).toEqual([
        expect.stringContaining("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
        APP_ANALYTICS_PATH,
      ]);
    });

    test("still rejects invalid requests", async () => {
      await startRelay({ env: {} });

      expect((await post("{}")).status).toBe(400);
    });

    test("resolves the collector per request", async () => {
      const env: NodeJS.ProcessEnv = {};
      await startRelay({ env });

      expect((await post(JSON.stringify(payload))).status).toBe(204);
      env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = collector.url;
      expect((await post(JSON.stringify(payload))).status).toBe(200);
      expect(collector.requests).toHaveLength(1);
    });
  });

  describe("load and shutdown", () => {
    async function waitForCollectorRequests(count: number): Promise<void> {
      await vi.waitFor(() => {
        expect(collector.requests).toHaveLength(count);
      });
    }

    test("answers 503 with Retry-After while too many forwards are in flight", async () => {
      await startRelay({ maxConcurrentForwards: 2 });
      let release = () => {};
      collector.hold = new Promise((resolve) => {
        release = resolve;
      });

      const held = [
        post(JSON.stringify(payload)),
        post(JSON.stringify(payload)),
      ];
      await waitForCollectorRequests(2);
      const overloaded = await post(JSON.stringify(payload));

      expect(overloaded.status).toBe(503);
      expect(overloaded.headers.get("retry-after")).toBe("1");
      expect(outcomes()).toContainEqual({
        outcome: "overloaded",
        "http.response.status_code": 503,
      });
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("forwards in flight"),
        2,
      );

      release();
      expect((await Promise.all(held)).map(({ status }) => status)).toEqual([
        200, 200,
      ]);
      expect((await post(JSON.stringify(payload))).status).toBe(200);
    });

    test("cancels forwards in flight on abort and answers 503 afterwards", async () => {
      await startRelay();
      let release = () => {};
      collector.hold = new Promise((resolve) => {
        release = resolve;
      });

      const held = post(JSON.stringify(payload));
      await waitForCollectorRequests(1);
      relay.abort();

      const cancelled = await held;
      expect(cancelled.status).toBe(503);
      expect(cancelled.headers.get("retry-after")).toBe("1");

      const later = await post(JSON.stringify(payload));
      expect(later.status).toBe(503);
      expect(collector.requests).toHaveLength(1);
      expect(loggerSpies.warn).not.toHaveBeenCalled();
      release();
    });
  });
});

describe("shouldInjectSdk", () => {
  const telemetryOn = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314" };

  test.each([
    ["by default", {}],
    ["with appAnalytics: true", { appAnalytics: true }],
    ["with browser options", { appAnalytics: { webVitals: true } }],
  ])("injects when App telemetry is on %s", (_label, config) => {
    expect(shouldInjectSdk(config, telemetryOn)).toBe(true);
  });

  test("injects with only the logs-specific endpoint", () => {
    expect(
      shouldInjectSdk(
        {},
        { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs" },
      ),
    ).toBe(true);
  });

  test("doesn't inject when App telemetry is off", () => {
    expect(shouldInjectSdk({ appAnalytics: { webVitals: true } }, {})).toBe(
      false,
    );
  });

  test("doesn't inject with appAnalytics: false", () => {
    expect(shouldInjectSdk({ appAnalytics: false }, telemetryOn)).toBe(false);
  });
});

describe("appAnalyticsBrowserOptions", () => {
  test.each([undefined, true, false])(
    "has no options for appAnalytics: %s",
    (appAnalytics) => {
      expect(appAnalyticsBrowserOptions(appAnalytics)).toEqual({});
    },
  );

  test("keeps the browser options", () => {
    expect(
      appAnalyticsBrowserOptions({
        webVitals: true,
        autocapture: false,
        sampleRate: 0.25,
      }),
    ).toEqual({ webVitals: true, autocapture: false, sampleRate: 0.25 });
  });

  test("drops unknown options and values of the wrong type", () => {
    expect(
      appAnalyticsBrowserOptions({
        webVitals: "yes",
        sampleRate: Number.NaN,
        endpoint: "/elsewhere",
      } as never),
    ).toEqual({});
  });
});

describe("serveSdk", () => {
  const source = "/*! sdk */console.log('app analytics');";
  let dir: string;
  let sdkServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-sdk-"));
    fs.writeFileSync(path.join(dir, "sdk.js"), source);

    const app = express();
    app.get(APP_ANALYTICS_SDK_PATH, serveSdk(path.join(dir, "sdk.js")));
    app.get("/missing.js", serveSdk(path.join(dir, "missing.js")));
    sdkServer = app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${await getListeningPort(sdkServer)}`;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    sdkServer.closeAllConnections();
    await new Promise<void>((resolve) => sdkServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("serves the build as JavaScript that browsers revalidate", async () => {
    const response = await fetch(`${baseUrl}${APP_ANALYTICS_SDK_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(source);
  });

  test("answers 304 to a request with the current ETag", async () => {
    const first = await fetch(`${baseUrl}${APP_ANALYTICS_SDK_PATH}`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    // node:http, because fetch adds `cache-control: no-cache` to conditional
    // requests, which makes Express answer 200.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          `${baseUrl}${APP_ANALYTICS_SDK_PATH}`,
          { headers: { "if-none-match": etag ?? "" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on("error", reject);
    });

    expect(status).toBe(304);
  });

  test("answers 404 and warns once when the build is missing", async () => {
    const first = await fetch(`${baseUrl}/missing.js`);
    const second = await fetch(`${baseUrl}/missing.js`);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn.mock.calls[0]).toEqual([
      expect.stringContaining("Could not read the App Analytics browser build"),
      path.join(dir, "missing.js"),
      expect.any(String),
      APP_ANALYTICS_SDK_PATH,
    ]);
  });
});
