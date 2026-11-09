import {
  createTestApp,
  getMock,
  type TestApp,
} from "@databricks/appkit/testing";
import { tableFromIPC } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppManager } from "../../../app";
import { analytics } from "../index";
import {
  cellsOf,
  type Dataset,
  type FakeStorage,
  schemaOf,
  startStorage,
  type StorageMode,
  typedDataset,
} from "./cloud-fetch-fixtures";

const LARGE = 26 * 1024 * 1024;
const TTL_MS = 10 * 60_000;

const getAppQuerySpy = vi.spyOn(AppManager.prototype, "getAppQuery");

type Warehouse = {
  executions: string[];
};

describe("Arrow charts when workspace storage refuses the Cloud Fetch download", () => {
  let app: TestApp<[ReturnType<typeof analytics>]>;
  let storage: FakeStorage;
  let warehouse: Warehouse;
  let data: Dataset;
  let executeStatement: ReturnType<typeof getMock>;
  let getResultData: ReturnType<typeof getMock>;

  /** The warehouse behind `statementExecution`, answering like a standard SQL warehouse. */
  function installWarehouse(
    options: {
      totalByteCount?: number;
      inline?: () => never;
    } = {},
  ) {
    let seq = 0;
    executeStatement.mockImplementation(async (body: any) => {
      warehouse.executions.push(`${body.disposition}+${body.format}`);
      const statementId = `stmt-${++seq}`;
      const manifest = (format: string) => ({
        format,
        schema: { columns: data.columns },
        totalChunkCount: 1,
        totalByteCount:
          options.totalByteCount === undefined
            ? undefined
            : BigInt(options.totalByteCount),
      });
      if (body.disposition === "INLINE" && body.format === "ARROW_STREAM") {
        throw Object.assign(
          new Error(
            "The format field must be JSON_ARRAY when the disposition field is INLINE.",
          ),
          { errorCode: "INVALID_PARAMETER_VALUE" },
        );
      }
      if (body.disposition === "EXTERNAL_LINKS") {
        return {
          statementId,
          status: { state: "SUCCEEDED" },
          manifest: manifest("ARROW_STREAM"),
          result: {
            externalLinks: [
              {
                chunkIndex: 0,
                externalLink: storage.url("chunk-0"),
                httpHeaders: { "x-ms-encryption-key": "k" },
              },
            ],
          },
        };
      }
      if (options.inline) return options.inline();
      return {
        statementId,
        status: { state: "SUCCEEDED" },
        manifest: manifest("JSON_ARRAY"),
        result: { dataArray: data.dataArray },
      };
    });
    getResultData.mockImplementation(async () => ({
      externalLinks: [
        {
          chunkIndex: 0,
          externalLink: storage.url("chunk-0-fresh"),
          httpHeaders: { "x-ms-encryption-key": "k" },
        },
      ],
    }));
  }

  async function boot(config: { timeout?: number } = {}) {
    app = await createTestApp({ plugins: [analytics(config)] });
    executeStatement = getMock(
      app.client,
      "statementExecution.executeStatement",
    );
    getResultData = getMock(app.client, "statementExecution.getResultData");
    getAppQuerySpy.mockResolvedValue({
      query: "SELECT * FROM sales",
      isAsUser: false,
    });
  }

  async function setStorage(mode: StorageMode) {
    storage = await startStorage(mode);
    storage.setBody(data.ipc);
  }

  beforeEach(() => {
    warehouse = { executions: [] };
    data = typedDataset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    getAppQuerySpy.mockReset();
    await app?.close();
    await storage?.close();
  });

  const chart = (key: string) =>
    app.post(`/api/analytics/query/${key}`, {
      body: { parameters: {}, format: "ARROW_STREAM" },
    });

  const columnsHeader = (res: Response) =>
    JSON.parse(
      decodeURIComponent(res.headers.get("X-Appkit-Arrow-Columns") ?? "null"),
    );

  async function expectNativeArrow(res: Response) {
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.apache.arrow.stream",
    );
    const native = tableFromIPC(data.ipc);
    const served = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(schemaOf(served)).toEqual(schemaOf(native));
    expect(cellsOf(served)).toEqual(cellsOf(native));
    expect(columnsHeader(res)).toEqual(data.columns.map((c) => c.name));
  }

  test("healthy storage is untouched by the fallback: same bytes, no inline run, one GET with the link's headers", async () => {
    await setStorage({ kind: "ok" });
    await boot();
    installWarehouse();

    const res = await chart("healthy");

    expect(res.status).toBe(200);
    expect(
      Buffer.from(await res.arrayBuffer()).equals(Buffer.from(data.ipc)),
    ).toBe(true);
    expect(columnsHeader(res)).toEqual(data.columns.map((c) => c.name));
    expect(warehouse.executions).toEqual([
      "INLINE+ARROW_STREAM",
      "EXTERNAL_LINKS+ARROW_STREAM",
    ]);
    expect(storage.gets()).toBe(1);
    expect(storage.requestHeaders[0]["x-ms-encryption-key"]).toBe("k");
  });

  test("a firewall that answers 403 still renders the chart, and the re-minted link is tried once", async () => {
    await setStorage({ kind: "status", status: 403 });
    await boot();
    installWarehouse();

    const res = await chart("firewalled");

    await expectNativeArrow(res);
    expect(warehouse.executions).toEqual([
      "INLINE+ARROW_STREAM",
      "EXTERNAL_LINKS+ARROW_STREAM",
      "INLINE+JSON_ARRAY",
    ]);
    expect(storage.gets()).toBe(2);
    expect(getResultData).toHaveBeenCalledTimes(1);
  });

  test("a definite refusal is remembered for ten minutes, then storage is tried again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await setStorage({ kind: "status", status: 403 });
    await boot();
    installWarehouse();

    await expectNativeArrow(await chart("first"));
    const getsAfterFirst = storage.gets();

    warehouse.executions.length = 0;
    await expectNativeArrow(await chart("second"));
    expect(warehouse.executions).toEqual(["INLINE+JSON_ARRAY"]);
    expect(storage.gets()).toBe(getsAfterFirst);

    warehouse.executions.length = 0;
    await expectNativeArrow(await chart("second"));
    expect(warehouse.executions).toEqual([]);

    vi.setSystemTime(Date.now() + TTL_MS + 1000);
    storage.setMode({ kind: "ok" });
    warehouse.executions.length = 0;
    const recovered = await chart("third");
    expect(
      Buffer.from(await recovered.arrayBuffer()).equals(Buffer.from(data.ipc)),
    ).toBe(true);
    expect(warehouse.executions).toEqual(["EXTERNAL_LINKS+ARROW_STREAM"]);
    expect(storage.gets()).toBe(getsAfterFirst + 1);
  });

  test("storage that never answers falls back, and the next chart tries storage again", async () => {
    await setStorage({ kind: "hang" });
    await boot({ timeout: 300 });
    installWarehouse();

    await expectNativeArrow(await chart("stalled"));
    expect(storage.gets()).toBe(1);

    warehouse.executions.length = 0;
    await expectNativeArrow(await chart("stalled-again"));
    expect(warehouse.executions).toContain("EXTERNAL_LINKS+ARROW_STREAM");
    expect(storage.gets()).toBe(2);
  });

  test("a body that stalls after the headers falls back instead of hanging", async () => {
    await setStorage({ kind: "hang-after-headers" });
    await boot({ timeout: 300 });
    installWarehouse();

    await expectNativeArrow(await chart("stalled-body"));
    expect(warehouse.executions.at(-1)).toBe("INLINE+JSON_ARRAY");
  });

  test("duplicate column names and JSON-looking strings come through the fallback intact", async () => {
    const payload = '{"id":9007199254740993, "label":"kept verbatim"}';
    data = {
      columns: [
        { name: "x", typeName: "INT", typeText: "INT", position: 0 },
        { name: "x", typeName: "INT", typeText: "INT", position: 1 },
        {
          name: "payload",
          typeName: "STRING",
          typeText: "STRING",
          position: 2,
        },
      ],
      dataArray: [["1", "2", payload]],
      ipc: new Uint8Array(),
    };
    await setStorage({ kind: "status", status: 403 });
    await boot();
    installWarehouse();

    const res = await chart("duplicates");

    expect(res.status).toBe(200);
    const served = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(cellsOf(served)).toEqual([["1", "2", payload]]);
    expect(columnsHeader(res)).toEqual(["x", "x", "payload"]);
  });

  test("a refused download of a result too large for inline answers with EXTERNAL_LINKS_DENIED and says why", async () => {
    await setStorage({ kind: "status", status: 403 });
    await boot();
    installWarehouse({ totalByteCount: LARGE });

    const res = await chart("large");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorCode: string };
    expect(body.errorCode).toBe("EXTERNAL_LINKS_DENIED");
    expect(body.error).toMatch(/workspace storage/);
    expect(body.error).toMatch(/too large to send inline/);
    expect(warehouse.executions).not.toContain("INLINE+JSON_ARRAY");
  });

  test("a large result behind storage that never answers is tried twice, then says why", async () => {
    await setStorage({ kind: "hang" });
    await boot({ timeout: 300 });
    installWarehouse({ totalByteCount: LARGE });

    const res = await chart("large-stalled");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe("EXTERNAL_LINKS_DENIED");
    expect(storage.gets()).toBe(2);
    expect(warehouse.executions).not.toContain("INLINE+JSON_ARRAY");
  });

  test("when the inline run fails for another reason the user sees that reason, not a storage message", async () => {
    await setStorage({ kind: "status", status: 403 });
    await boot();
    installWarehouse({
      inline: () => {
        throw Object.assign(new Error("User does not have SELECT"), {
          errorCode: "PERMISSION_DENIED",
        });
      },
    });

    const res = await chart("permission");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorCode: string };
    expect(body.errorCode).toBe("PERMISSION_DENIED");
    expect(body.error).not.toMatch(/storage|firewall/i);
  });
});
