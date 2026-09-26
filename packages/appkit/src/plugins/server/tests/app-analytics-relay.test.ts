import type { Server } from "node:http";

import { getListeningPort } from "@databricks/appkit/testing";
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

import {
  APP_ANALYTICS_PATH,
  appAnalyticsGuard,
  appAnalyticsRelay,
  forwardOtlpLogs,
  resolveOtlpLogsEndpoint,
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

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

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

function makeReq(body: unknown = payload) {
  return {
    method: "POST",
    url: APP_ANALYTICS_PATH,
    body,
    headers: {
      "content-type": "application/json",
      cookie: "session=secret",
      "x-forwarded-access-token": "user-token",
    },
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
}

async function relay(
  handler: ReturnType<typeof appAnalyticsRelay>,
  req = makeReq(),
) {
  const res = makeRes();
  const next = vi.fn();
  await handler(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

function stubFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolveOtlpLogsEndpoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("appends the standard logs path to the shared endpoint", () => {
    expect(
      resolveOtlpLogsEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4314",
      }),
    ).toBe("http://localhost:4314/v1/logs");
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

  test("returns undefined when App telemetry is off", () => {
    expect(resolveOtlpLogsEndpoint({})).toBeUndefined();
    expect(
      resolveOtlpLogsEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
      }),
    ).toBeUndefined();
  });

  test("reads process.env by default", () => {
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "http://127.0.0.1:4318/logs",
    );

    expect(resolveOtlpLogsEndpoint()).toBe("http://127.0.0.1:4318/logs");
  });
});

describe("forwardOtlpLogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("posts the payload as JSON without following redirects", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch(
      async () => new Response(null, { status: 200 }),
    );

    await forwardOtlpLogs(payload, "http://localhost:4314/v1/logs");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("http://localhost:4314/v1/logs");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  test("returns the collector status and releases the response body", async () => {
    const response = new Response("partial success", { status: 202 });
    const body = response.body;
    if (body === null) throw new Error("Expected a response body");
    const cancel = vi.spyOn(body, "cancel");
    stubFetch(async () => response);

    await expect(
      forwardOtlpLogs(payload, "http://localhost:4314/v1/logs"),
    ).resolves.toBe(202);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("rejects when the collector can't be reached", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      forwardOtlpLogs(payload, "http://localhost:4314/v1/logs"),
    ).rejects.toThrow("fetch failed");
  });
});

describe("appAnalyticsGuard", () => {
  const reached = vi.fn();
  const errorHandler = vi.fn();
  let guarded: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A bare Express app, without AppKit's global JSON parser, so the guard's
    // own parser reads every body.
    const app = express();
    app.post(
      APP_ANALYTICS_PATH,
      appAnalyticsGuard(),
      (req: express.Request, res: express.Response) => {
        reached(req.body);
        res.status(200).end();
      },
    );
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
    guarded = app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${await getListeningPort(guarded)}`;
  });

  afterEach(() => {
    reached.mockClear();
    errorHandler.mockClear();
  });

  afterAll(async () => {
    guarded.closeAllConnections();
    await new Promise<void>((resolve) => guarded.close(() => resolve()));
  });

  function post(
    body: string,
    contentType = "application/json",
    path = APP_ANALYTICS_PATH,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  /** An OTLP logs body of exactly `bytes` bytes. */
  function bodyOfSize(bytes: number): string {
    const overhead = JSON.stringify({ resourceLogs: [], padding: "" }).length;
    return JSON.stringify({
      resourceLogs: [],
      padding: "x".repeat(bytes - overhead),
    });
  }

  async function expectRejected(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(reached).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  }

  test("passes an OTLP logs body on, parsed", async () => {
    const response = await post(JSON.stringify(payload));

    expect(response.status).toBe(200);
    expect(reached).toHaveBeenCalledWith(payload);
  });

  test("accepts a JSON content type with parameters", async () => {
    const response = await post(
      JSON.stringify(payload),
      "application/json; charset=utf-8",
    );

    expect(response.status).toBe(200);
  });

  test("accepts a 48 KiB batch, the largest the SDK sends", async () => {
    const response = await post(bodyOfSize(48 * 1024));

    expect(response.status).toBe(200);
  });

  test("answers 413 when the body is over 64 KiB", async () => {
    await expectRejected(await post(bodyOfSize(64 * 1024 + 1)), 413);
  });

  test.each(["text/plain", "application/x-www-form-urlencoded"])(
    "answers 415 for %s",
    async (contentType) => {
      await expectRejected(
        await post(JSON.stringify(payload), contentType),
        415,
      );
    },
  );

  test("answers 400 when the body isn't valid JSON", async () => {
    await expectRejected(await post('{"resourceLogs":'), 400);
  });

  test.each([
    "{}",
    "[]",
    '{"resourceLogs":null}',
    '{"resourceLogs":{"scopeLogs":[]}}',
  ])("answers 400 when resourceLogs isn't an array: %s", async (body) => {
    await expectRejected(await post(body), 400);
  });

  test.each([`${APP_ANALYTICS_PATH}/`, APP_ANALYTICS_PATH.toUpperCase()])(
    "leaves %s to later routes",
    async (path) => {
      const response = await post(JSON.stringify(payload), undefined, path);

      expect(response.status).toBe(404);
      expect(reached).not.toHaveBeenCalled();
    },
  );
});

describe("appAnalyticsRelay", () => {
  const originalEnv = Object.fromEntries(
    OTEL_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    for (const key of OTEL_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of OTEL_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("forwards the body to the collector without incoming headers", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    const fetchMock = stubFetch(
      async () => new Response(null, { status: 200 }),
    );

    await relay(appAnalyticsRelay());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("http://localhost:4314/v1/logs");
    expect(init?.body).toBe(JSON.stringify(payload));
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  test.each([200, 202, 400, 429, 503])(
    "answers with the collector's %i and an empty body",
    async (status) => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
      stubFetch(async () => new Response("collector details", { status }));

      const res = await relay(appAnalyticsRelay());

      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.end).toHaveBeenCalledWith();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    },
  );

  test("answers 502 when the collector can't be reached", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await relay(appAnalyticsRelay());

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith();
  });

  test("answers 502 when the collector times out", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    stubFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const res = await relay(appAnalyticsRelay());

    expect(res.status).toHaveBeenCalledWith(502);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.any(String),
      "http://localhost:4314/v1/logs",
      "no answer within 5000 ms",
    );
  });

  test("warns once, with the network cause, when forwarding fails", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    stubFetch(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:4314"),
      });
    });
    const handler = appAnalyticsRelay();

    const first = await relay(handler);
    const second = await relay(handler);

    for (const res of [first, second]) {
      expect(res.status).toHaveBeenCalledWith(502);
    }
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn.mock.calls[0]).toEqual([
      expect.stringContaining("Could not forward App Analytics records"),
      "http://localhost:4314/v1/logs",
      "fetch failed: connect ECONNREFUSED 127.0.0.1:4314",
    ]);
  });

  test("doesn't warn when the collector answers with an error status", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4314";
    stubFetch(async () => new Response(null, { status: 503 }));

    const res = await relay(appAnalyticsRelay());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(loggerSpies.warn).not.toHaveBeenCalled();
  });

  test("answers 204 and warns once when App telemetry is off", async () => {
    const fetchMock = stubFetch(
      async () => new Response(null, { status: 200 }),
    );
    const handler = appAnalyticsRelay();

    const first = await relay(handler);
    const second = await relay(handler);

    expect(fetchMock).not.toHaveBeenCalled();
    for (const res of [first, second]) {
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalledWith();
    }
    expect(loggerSpies.warn).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn.mock.calls[0]).toEqual([
      expect.stringContaining("App telemetry is off"),
      APP_ANALYTICS_PATH,
    ]);
  });

  test("resolves the endpoint per request", async () => {
    const fetchMock = stubFetch(
      async () => new Response(null, { status: 200 }),
    );
    const handler = appAnalyticsRelay();

    await relay(handler);
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://127.0.0.1:4318/logs";
    const res = await relay(handler);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4318/logs");
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
