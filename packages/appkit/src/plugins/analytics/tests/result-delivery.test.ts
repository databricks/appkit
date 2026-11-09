import {
  Table,
  tableFromIPC,
  tableToIPC,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ExecutionError } from "../../../errors";
import { ArrowStreamProcessor } from "../../../stream/arrow-stream-processor";
import {
  type ArrowChunkStreamer,
  type ArrowDeliveryOut,
  type ArrowCapability,
  arrowDeliveryUnsupported,
  classifyDispositionRejection,
  decodeArrowAttachmentToRows,
  deliverArrowBytes,
  deliverArrowBytesWithFallback,
  deliverJsonResult,
  type QueryExecutor,
} from "../result-delivery";
import {
  cellsOf,
  type Dataset,
  type FakeStorage,
  schemaOf,
  startStorage,
  typedDataset,
} from "./cloud-fetch-fixtures";

/** Build a base64 Arrow IPC stream (2 cols, given names + rows). */
function arrowBase64(names: [string, string]): string {
  const table = new Table({
    [names[0]]: vectorFromArray(["r0", "r1"], new Utf8()),
    [names[1]]: vectorFromArray(["v0", "v1"], new Utf8()),
  });
  return Buffer.from(tableToIPC(table, "stream")).toString("base64");
}

/** Fake executor whose `query` is driven by the requested disposition/format. */
function executorFrom(
  handler: (fp: { disposition: string; format: string }) => Promise<unknown>,
): {
  executor: QueryExecutor;
  calls: { disposition: string; format: string }[];
} {
  const calls: { disposition: string; format: string }[] = [];
  const executor: QueryExecutor = {
    query: (_q, _p, fp) => {
      calls.push(fp);
      return handler(fp) as ReturnType<QueryExecutor["query"]>;
    },
  };
  return { executor, calls };
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

const reject = (code: string, message: string) =>
  ExecutionError.statementFailed(message, code);

describe("classifyDispositionRejection", () => {
  test("normal warehouse rejecting ARROW+INLINE → needs-json-inline", () => {
    expect(
      classifyDispositionRejection(
        reject(
          "INVALID_PARAMETER_VALUE",
          "The format field must be JSON_ARRAY when the disposition field is INLINE.",
        ),
      ),
    ).toBe("needs-json-inline");
  });

  test("warehouse requiring ARROW for INLINE → needs-arrow-inline", () => {
    expect(
      classifyDispositionRejection(
        reject(
          "INVALID_PARAMETER_VALUE",
          "Inline disposition only supports ARROW_STREAM format.",
        ),
      ),
    ).toBe("needs-arrow-inline");
  });

  test("EXTERNAL_LINKS not implemented (Reyden) → external-links-unsupported", () => {
    expect(
      classifyDispositionRejection(
        reject(
          "NOT_IMPLEMENTED",
          "ExternalLinks disposition is not yet implemented.",
        ),
      ),
    ).toBe("external-links-unsupported");
  });

  test("permission error does NOT fall back", () => {
    expect(
      classifyDispositionRejection(
        reject("PERMISSION_DENIED", "User does not have SELECT on table t"),
      ),
    ).toBeNull();
  });

  test("plain SQL error does NOT fall back", () => {
    expect(
      classifyDispositionRejection(new Error("Table or view not found: foo")),
    ).toBeNull();
  });

  test("capability code without an inline/external signal does NOT fall back", () => {
    expect(
      classifyDispositionRejection(
        reject("INVALID_PARAMETER_VALUE", "Some unrelated parameter problem"),
      ),
    ).toBeNull();
  });
});

describe("deliverArrowBytes — Reyden (ARROW + INLINE)", () => {
  test("streams the inline attachment and never touches external links", async () => {
    const b64 = arrowBase64(["col_0", "col_1"]);
    const { executor, calls } = executorFrom(async () => ({
      attachment: b64,
      columnNames: ["name", "spend"],
      statement_id: "stmt-inline",
    }));
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {}),
    };
    const out: { columnNames?: string[]; statementId?: string } = {};

    const chunks = await collect(
      deliverArrowBytes(executor, streamer, "SELECT 1", undefined, out),
    );

    expect(calls).toEqual([{ disposition: "INLINE", format: "ARROW_STREAM" }]);
    expect(streamer.streamExternalLinks).not.toHaveBeenCalled();
    expect(out.columnNames).toEqual(["name", "spend"]);
    expect(out.statementId).toBe("stmt-inline");
    // Bytes are the decoded attachment.
    expect(
      Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("base64"),
    ).toBe(b64);
  });
});

describe("deliverArrowBytes — normal warehouse (fallback to EXTERNAL_LINKS)", () => {
  test("INLINE rejected → streams the external links from the execute response", async () => {
    const links = [{ external_link: "https://example.com/chunk-0" }];
    const { executor, calls } = executorFrom(async (fp) => {
      if (fp.disposition === "INLINE") {
        throw reject(
          "INVALID_PARAMETER_VALUE",
          "The format field must be JSON_ARRAY when the disposition field is INLINE.",
        );
      }
      return {
        external_links: links,
        columnNames: ["a", "b"],
        statement_id: "stmt-ext",
      };
    });
    const extBytes = new Uint8Array([9, 8, 7]);
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {
        yield extBytes;
      }),
    };
    const out: { columnNames?: string[]; statementId?: string } = {};

    const chunks = await collect(
      deliverArrowBytes(executor, streamer, "SELECT 1", undefined, out),
    );

    expect(calls).toEqual([
      { disposition: "INLINE", format: "ARROW_STREAM" },
      { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" },
    ]);
    // Streams the links resolved in-context (no re-fetch): passed straight
    // through, along with the (here absent) chunk-link refresher.
    expect(streamer.streamExternalLinks).toHaveBeenCalledWith(
      links,
      undefined,
      undefined,
      false,
    );
    expect(out.columnNames).toEqual(["a", "b"]);
    expect(chunks).toEqual([extBytes]);
  });

  test("both INLINE and EXTERNAL_LINKS unsupported → ARROW_DELIVERY_UNSUPPORTED", async () => {
    const { executor } = executorFrom(async (fp) => {
      if (fp.disposition === "INLINE") {
        throw reject(
          "INVALID_PARAMETER_VALUE",
          "The format field must be JSON_ARRAY when the disposition field is INLINE.",
        );
      }
      throw reject(
        "NOT_IMPLEMENTED",
        "ExternalLinks disposition is not yet implemented.",
      );
    });
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {}),
    };

    await expect(
      collect(deliverArrowBytes(executor, streamer, "SELECT 1", undefined, {})),
    ).rejects.toMatchObject({ errorCode: "ARROW_DELIVERY_UNSUPPORTED" });
  });

  test("auth/permission error on INLINE propagates without a fallback", async () => {
    const authErr = reject("PERMISSION_DENIED", "no access");
    const { executor, calls } = executorFrom(async () => {
      throw authErr;
    });
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {}),
    };

    await expect(
      collect(deliverArrowBytes(executor, streamer, "SELECT 1", undefined, {})),
    ).rejects.toBe(authErr);
    // Only the INLINE attempt — no EXTERNAL_LINKS fallback.
    expect(calls).toEqual([{ disposition: "INLINE", format: "ARROW_STREAM" }]);
  });
});

describe("deliverJsonResult", () => {
  test("INLINE JSON_ARRAY success returns rows directly", async () => {
    const { executor, calls } = executorFrom(async () => ({
      data: [{ id: 1 }],
      status: { state: "SUCCEEDED" },
      statement_id: "s1",
    }));
    const result = await deliverJsonResult(executor, "SELECT 1", undefined);
    expect(result.data).toEqual([{ id: 1 }]);
    expect(calls).toEqual([{ disposition: "INLINE", format: "JSON_ARRAY" }]);
  });

  test("needs-arrow-inline → retries as ARROW and decodes rows with manifest names", async () => {
    const b64 = arrowBase64(["col_0", "col_1"]);
    const { executor, calls } = executorFrom(async (fp) => {
      if (fp.format === "JSON_ARRAY") {
        throw reject(
          "INVALID_PARAMETER_VALUE",
          "Inline disposition only supports ARROW_STREAM format.",
        );
      }
      return { attachment: b64, columnNames: ["name", "spend"] };
    });
    const result = await deliverJsonResult(executor, "SELECT 1", undefined);
    expect(calls).toEqual([
      { disposition: "INLINE", format: "JSON_ARRAY" },
      { disposition: "INLINE", format: "ARROW_STREAM" },
    ]);
    // Rows carry the manifest names, not the positional col_N names.
    expect(result.data).toEqual([
      { name: "r0", spend: "v0" },
      { name: "r1", spend: "v1" },
    ]);
  });
});

describe("decodeArrowAttachmentToRows", () => {
  test("relabels positional columns from manifest names", () => {
    const rows = decodeArrowAttachmentToRows(arrowBase64(["col_0", "col_1"]), [
      "name",
      "spend",
    ]);
    expect(rows).toEqual([
      { name: "r0", spend: "v0" },
      { name: "r1", spend: "v1" },
    ]);
  });
});

describe("deliverArrowBytes — capability memo", () => {
  test("reports 'inline' when the INLINE attempt succeeds", async () => {
    const { executor } = executorFrom(async () => ({
      attachment: arrowBase64(["col_0", "col_1"]),
      columnNames: ["a", "b"],
      statement_id: "s",
    }));
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {}),
    };
    const resolved: string[] = [];
    await collect(
      deliverArrowBytes(
        executor,
        streamer,
        "SELECT 1",
        undefined,
        {},
        undefined,
        {
          onCapabilityResolved: (c) => resolved.push(c),
        },
      ),
    );
    expect(resolved).toEqual(["inline"]);
  });

  test("reports 'external' after falling back to EXTERNAL_LINKS", async () => {
    const links = [{ external_link: "https://x/0" }];
    const { executor } = executorFrom(async (fp) => {
      if (fp.disposition === "INLINE") {
        throw reject(
          "INVALID_PARAMETER_VALUE",
          "The format field must be JSON_ARRAY when the disposition field is INLINE.",
        );
      }
      return { external_links: links, columnNames: ["a"], statement_id: "s" };
    });
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {
        yield new Uint8Array([1]);
      }),
    };
    const resolved: string[] = [];
    await collect(
      deliverArrowBytes(
        executor,
        streamer,
        "SELECT 1",
        undefined,
        {},
        undefined,
        {
          onCapabilityResolved: (c) => resolved.push(c),
        },
      ),
    );
    expect(resolved).toEqual(["external"]);
  });

  test("capabilityHint 'external' skips the INLINE probe entirely", async () => {
    const links = [{ external_link: "https://x/0" }];
    const { executor, calls } = executorFrom(async (fp) => {
      if (fp.disposition === "INLINE") {
        throw new Error("INLINE should not have been attempted");
      }
      return { external_links: links, columnNames: ["a"], statement_id: "s" };
    });
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: vi.fn(async function* () {
        yield new Uint8Array([1]);
      }),
    };
    await collect(
      deliverArrowBytes(
        executor,
        streamer,
        "SELECT 1",
        undefined,
        {},
        undefined,
        {
          capabilityHint: "external",
        },
      ),
    );
    // Only EXTERNAL_LINKS was attempted — no wasted INLINE probe.
    expect(calls).toEqual([
      { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" },
    ]);
  });
});

describe("arrowDeliveryUnsupported", () => {
  test("is a structured, client-actionable error", () => {
    const err = arrowDeliveryUnsupported();
    expect(err.errorCode).toBe("ARROW_DELIVERY_UNSUPPORTED");
    expect(err.clientMessage).toMatch(/JSON_ARRAY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Captured-fixture round-trip: real bytes from a live Reyden serverless
// warehouse (id 000000000000000d), which refuses INLINE + JSON_ARRAY and only
// serves INLINE + ARROW_STREAM. Each fixture pairs the base64 Arrow IPC
// attachment with the exact `data_array` the same query returns under native
// JSON_ARRAY — the shape `decodeArrowAttachmentToRows` must reproduce so a
// JSON_ARRAY caller cannot tell the fallback path from the native one.
// Captured 2026-07-09; regenerate by re-running the query under both formats.
// ─────────────────────────────────────────────────────────────────────────
const REYDEN_SCALAR_FIXTURE = {
  // amt DECIMAL(10,2), neg DECIMAL(10,2), ts TIMESTAMP, ts_ntz TIMESTAMP_NTZ,
  // d DATE, s STRUCT<amt DECIMAL, ts TIMESTAMP>, arr ARRAY<DECIMAL>
  attachment:
    "/////3gCAAAQAAAAAAAKAAwACgAJAAQACgAAABAAAAAAAQQACAAIAAAABAAIAAAABAAAAAcAAAD4AQAAuAEAAHQBAAA0AQAACAEAAGAAAAAEAAAANP7//xgAAAAMAAAAAAABDEAAAAABAAAACAAAAKT///9o////FAAAAAwAAAAAAAAHFAAAAAAAAABE/v//AgAAAAoAAAAEAAAAaXRlbQAAAAADAAAAYXJyAIz+//8gAAAADAAAAAAAAQ2MAAAAAgAAAFgAAAAMAAAABAAEAAQAAADI////FAAAAAwAAAAAAAAKIAAAAAAAAAAg////CAAAAAAAAgAHAAAARXRjL1VUQwACAAAAdHMAABAAFAAQAAAADwAEAAAACAAQAAAAFAAAAAwAAAAAAAAHFAAAAAAAAADs/v//AgAAAAoAAAADAAAAYW10AAEAAABzAAAAMP///xQAAAAMAAAAAAABCBAAAAAAAAAA1v///wAAAAABAAAAZAAAAFj///8cAAAADAAAAAAAAQogAAAAAAAAAAAABgAIAAYABgAAAAAAAgAAAAAAAAAAAAYAAAB0c19udHoAAJT///8cAAAADAAAAAAAAQooAAAAAAAAAAgADAAKAAQACAAAAAgAAAAAAAIABwAAAEV0Yy9VVEMAAgAAAHRzAADU////FAAAAAwAAAAAAAEHFAAAAAAAAADE////AgAAAAoAAAADAAAAbmVnABAAFAAQAA4ADwAEAAAACAAQAAAAHAAAAAwAAAAAAAEHHAAAAAAAAAAIAAwACAAEAAgAAAACAAAACgAAAAMAAABhbXQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////84AgAAEAAAAAwAGgAYABcABAAIAAwAAAAgAAAAwAQAAAAAAAAAAAAAAAAAAwQACgAYAAwACAAEAAoAAAC8AAAAEAAAAAEAAAAAAAAAAAAAAAoAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAABMAAAAAAAAAAAAAAAEAAAAAAAAAQAAAAAAAAAAQAAAAAAAAAIAAAAAAAAAAAQAAAAAAAADAAAAAAAAAABAAAAAAAAAAAAEAAAAAAAABAAAAAAAAAEABAAAAAAAACAAAAAAAAACAAQAAAAAAAAEAAAAAAAAAwAEAAAAAAAAIAAAAAAAAAAACAAAAAAAAAQAAAAAAAABAAgAAAAAAAAQAAAAAAAAAgAIAAAAAAAABAAAAAAAAAMACAAAAAAAAAQAAAAAAAAAAAwAAAAAAABAAAAAAAAAAQAMAAAAAAAABAAAAAAAAAIADAAAAAAAACAAAAAAAAADAAwAAAAAAAAEAAAAAAAAAAAQAAAAAAAAIAAAAAAAAAEAEAAAAAAAAAQAAAAAAAACABAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ3///////////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQPMmch+bBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA8yZyH5sFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFdHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADkwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQPMmch+bBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADkwAAAAAAAAAAAAAAAAAABjAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////AAAAAA==",
  columns: ["amt", "neg", "ts", "ts_ntz", "d", "s", "arr"],
  expected: {
    amt: "123.45",
    neg: "-0.99",
    ts: "2020-01-02T03:04:05.000Z",
    ts_ntz: "2020-01-02T03:04:05.000",
    d: "2020-01-02",
    s: '{"amt":"123.45","ts":"2020-01-02T03:04:05.000Z"}',
    arr: '["123.45","0.99"]',
  },
} as const;

const REYDEN_NESTED_FIXTURE = {
  // s STRUCT with 6 scalar-leaf types, arr_dec ARRAY<DECIMAL>, arr_int
  // ARRAY<INT>, m MAP<STRING,DECIMAL>, deep STRUCT<STRUCT<DECIMAL>>, nul
  // DECIMAL (null).
  attachment:
    "//////gDAAAQAAAAAAAKAAwACgAJAAQACgAAABAAAAAAAQQACAAIAAAABAAIAAAABAAAAAYAAAA8AgAAzAEAAGwBAAC8AAAANAAAAAQAAADs/f//FAAAAAwAAAAAAAEHFAAAAAAAAACg/P//AgAAAAoAAAADAAAAbnVsABj+//8YAAAADAAAAAAAAQ1oAAAAAQAAAAgAAABA/f///Pz//xgAAAAMAAAAAAAADTwAAAABAAAACAAAAGD9//8c/f//FAAAAAwAAAAAAAAHFAAAAAAAAAAM/f//AgAAAAoAAAADAAAAYW10AAUAAABpbm5lcgAAAAQAAABkZWVwAAAAAJz+//8YAAAADAAAAAAAARGUAAAAAQAAAAgAAADE/f//gP3//xwAAAAMAAAAAAAADWgAAAACAAAAPAAAAAgAAADo/f//pP3//xQAAAAMAAAAAAAABxQAAAAAAAAAlP3//wIAAAAKAAAABQAAAHZhbHVlAAAA1P3//xQAAAAMAAAAAAAABQwAAAAAAAAANP7//wMAAABrZXkABwAAAGVudHJpZXMAAQAAAG0AAABI////GAAAAAwAAAAAAAEMQAAAAAEAAAAIAAAAcP7//yz+//8QAAAAGAAAAAAAAAIUAAAAYP7//yAAAAAAAAABAAAAAAQAAABpdGVtAAAAAAcAAABhcnJfaW50AKT///8YAAAADAAAAAAAAQxAAAAAAQAAAAgAAADM/v//iP7//xQAAAAMAAAAAAAABxQAAAAAAAAAeP7//wIAAAAKAAAABAAAAGl0ZW0AAAAABwAAAGFycl9kZWMAEAAUABAADgAPAAQAAAAIABAAAAAsAAAADAAAAAAAAQ1gAQAABgAAACQBAADcAAAArAAAAIAAAAA8AAAACAAAAEz///8I////HAAAAAwAAAAAAAAIGAAAAAAAAAAAAAYACAAGAAYAAAAAAAAAAQAAAGQAAAA4////HAAAAAwAAAAAAAAKKAAAAAAAAAAIAAwACgAEAAgAAAAIAAAAAAACAAcAAABFdGMvVVRDAAIAAAB0cwAAeP///xQAAAAMAAAAAAAABgwAAAAAAAAA2P///wQAAABmbGFnAAAAAKD///8YAAAADAAAAAAAAAUQAAAAAAAAAAQABAAEAAAABAAAAG5hbWUAAAAAzP///xgAAAAgAAAAAAAAAhwAAAAIAAwABAALAAgAAAAgAAAAAAAAAQAAAAABAAAAbgAAABAAFAAQAAAADwAEAAAACAAQAAAAHAAAAAwAAAAAAAAHHAAAAAAAAAAIAAwACAAEAAgAAAACAAAACgAAAAMAAABhbXQAAQAAAHMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/////4AwAAEAAAAAwAGgAYABcABAAIAAwAAAAgAAAAAAkAAAAAAAAAAAAAAAAAAwQACgAYAAwACAAEAAoAAABMAQAAEAAAAAEAAAAAAAAAAAAAABMAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAEAAAAAAAAAQAAAAAAAAAABAAAAAAAAAIAAAAAAAAAAEAAAAAAAAADAAAAAAAAAAAEAAAAAAAAAAAEAAAAAAAAEAAAAAAAAAEABAAAAAAAAAQAAAAAAAACAAQAAAAAAAAgAAAAAAAAAwAEAAAAAAAACAAAAAAAAAAACAAAAAAAAAQAAAAAAAABAAgAAAAAAAAEAAAAAAAAAgAIAAAAAAAABAAAAAAAAAMACAAAAAAAACAAAAAAAAAAAAwAAAAAAAAEAAAAAAAAAQAMAAAAAAAAEAAAAAAAAAIADAAAAAAAAAQAAAAAAAADAAwAAAAAAAAgAAAAAAAAAAAQAAAAAAAABAAAAAAAAAEAEAAAAAAAAIAAAAAAAAACABAAAAAAAAAEAAAAAAAAAwAQAAAAAAAAIAAAAAAAAAAAFAAAAAAAAAQAAAAAAAABABQAAAAAAAAwAAAAAAAAAgAUAAAAAAAABAAAAAAAAAMAFAAAAAAAACAAAAAAAAAAABgAAAAAAAAEAAAAAAAAAQAYAAAAAAAABAAAAAAAAAIAGAAAAAAAADAAAAAAAAADABgAAAAAAAAQAAAAAAAAAAAcAAAAAAAABAAAAAAAAAEAHAAAAAAAAIAAAAAAAAACABwAAAAAAAAEAAAAAAAAAwAcAAAAAAAABAAAAAAAAAAAIAAAAAAAAAQAAAAAAAABACAAAAAAAABAAAAAAAAAAgAgAAAAAAAABAAAAAAAAAMAIAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaGkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDzJnIfmwUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV0cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJYAAAAAAAAAAAAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAgAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABrMWsyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJYAAAAAAAAAAAAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADnAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/////AAAAAA==",
  columns: ["s", "arr_dec", "arr_int", "m", "deep", "nul"],
  expected: {
    s: '{"amt":"1.50","n":"42","name":"hi","flag":"true","ts":"2020-01-02T03:04:05.000Z","d":"2020-01-02"}',
    arr_dec: '["1.50","2.50"]',
    arr_int: '["1","2","3"]',
    m: '{"k1":"1.50","k2":"2.50"}',
    deep: '{"inner":{"amt":"9.99"}}',
    nul: null,
  },
} as const;

describe("decodeArrowAttachmentToRows — captured Reyden fixtures", () => {
  test("scalar decimal/timestamp/timestamp_ntz/date + one-level nested match native JSON_ARRAY", () => {
    const rows = decodeArrowAttachmentToRows(
      REYDEN_SCALAR_FIXTURE.attachment,
      REYDEN_SCALAR_FIXTURE.columns as unknown as string[],
    );
    expect(rows).toEqual([REYDEN_SCALAR_FIXTURE.expected]);
  });

  test("nested struct/list/map leaves are formatted by type, not corrupted to unscaled ints or epoch-ms", () => {
    const rows = decodeArrowAttachmentToRows(
      REYDEN_NESTED_FIXTURE.attachment,
      REYDEN_NESTED_FIXTURE.columns as unknown as string[],
    );
    expect(rows).toEqual([REYDEN_NESTED_FIXTURE.expected]);
  });
});

describe("deliverArrowBytesWithFallback", () => {
  const LARGE = 26 * 1024 * 1024;
  const storages: FakeStorage[] = [];

  afterEach(async () => {
    await Promise.all(storages.splice(0).map((st) => st.close()));
  });

  async function setup(
    options: {
      storage?: Parameters<typeof startStorage>[0];
      totalByteCount?: number;
      inline?: () => unknown;
      rows?: number;
    } = {},
  ) {
    const data: Dataset = typedDataset(options.rows);
    const storage = await startStorage(options.storage);
    storage.setBody(data.ipc);
    storages.push(storage);
    const executions: string[] = [];
    const executor: QueryExecutor = {
      query: async (_q, _p, fp) => {
        executions.push(`${fp.disposition}+${fp.format}`);
        if (fp.disposition === "INLINE" && fp.format === "ARROW_STREAM") {
          throw ExecutionError.statementFailed(
            "The format field must be JSON_ARRAY when the disposition field is INLINE.",
            "INVALID_PARAMETER_VALUE",
          );
        }
        if (fp.disposition === "EXTERNAL_LINKS") {
          return {
            statement_id: "stmt-links",
            columnNames: data.columns.map((c) => c.name),
            totalByteCount: options.totalByteCount,
            external_links: [{ chunkIndex: 0, externalLink: storage.url() }],
          };
        }
        if (options.inline) return options.inline() as never;
        return {
          statement_id: "stmt-json",
          columns: data.columns,
          columnNames: data.columns.map((c) => c.name),
          dataArray: data.dataArray,
        };
      },
    };
    const processor = new ArrowStreamProcessor({
      timeout: 1000,
      retries: 2,
      responseTimeoutMs: 100,
    });
    const streamer: ArrowChunkStreamer = {
      streamExternalLinks: (links, signal, refresh, patient) =>
        processor.streamChunks(links, signal, refresh, patient),
    };
    return { data, storage, executions, executor, streamer };
  }

  async function run(
    ctx: Awaited<ReturnType<typeof setup>>,
    capabilityHint?: ArrowCapability,
  ) {
    const out: ArrowDeliveryOut = {};
    const reported: ArrowCapability[] = [];
    const chunks: Uint8Array[] = [];
    let error: ExecutionError | undefined;
    try {
      for await (const bytes of deliverArrowBytesWithFallback(
        ctx.executor,
        ctx.streamer,
        "SELECT 1",
        undefined,
        out,
        undefined,
        {
          capabilityHint,
          onCapabilityResolved: (c) => reported.push(c),
        },
      )) {
        chunks.push(bytes);
      }
    } catch (e) {
      error = e as ExecutionError;
    }
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { bytes, out, reported, error };
  }

  const expectNativeArrow = (ctx: { data: Dataset }, bytes: Uint8Array) => {
    const native = tableFromIPC(ctx.data.ipc);
    const served = tableFromIPC(new Uint8Array(bytes));
    expect(schemaOf(served)).toEqual(schemaOf(native));
    expect(cellsOf(served)).toEqual(cellsOf(native));
  };

  test("a healthy workspace streams the download and never runs the inline fallback", async () => {
    const ctx = await setup();
    const { bytes, reported, error } = await run(ctx);

    expect(error).toBeUndefined();
    expect(Buffer.from(ctx.data.ipc).equals(bytes)).toBe(true);
    expect(ctx.executions).toEqual([
      "INLINE+ARROW_STREAM",
      "EXTERNAL_LINKS+ARROW_STREAM",
    ]);
    expect(ctx.storage.gets()).toBe(1);
    expect(reported).toEqual(["external"]);
  });

  test.each([403, 400])(
    "a %i from storage serves rebuilt Arrow equal to the native result and reports links-denied",
    async (status) => {
      const ctx = await setup({ storage: { kind: "status", status } });
      const { bytes, out, reported, error } = await run(ctx);

      expect(error).toBeUndefined();
      expectNativeArrow(ctx, bytes);
      expect(out.columnNames).toEqual(ctx.data.columns.map((c) => c.name));
      expect(out.statementId).toBe("stmt-json");
      expect(ctx.executions).toEqual([
        "INLINE+ARROW_STREAM",
        "EXTERNAL_LINKS+ARROW_STREAM",
        "INLINE+JSON_ARRAY",
      ]);
      expect(reported.at(-1)).toBe("links-denied");
    },
  );

  test("storage that never answers falls back and is remembered as denied", async () => {
    const ctx = await setup({ storage: { kind: "hang" } });
    const { bytes, reported, error } = await run(ctx);

    expect(error).toBeUndefined();
    expectNativeArrow(ctx, bytes);
    expect(ctx.storage.gets()).toBe(1);
    expect(ctx.executions.at(-1)).toBe("INLINE+JSON_ARRAY");
    expect(reported.at(-1)).toBe("links-denied");
  });

  test.each([
    ["headers then no body", { kind: "hang-after-headers" }],
    ["headers then a reset", { kind: "reset-after-headers" }],
  ] as const)(
    "storage with %s falls back once and is not remembered as denied",
    async (_name, storage) => {
      const ctx = await setup({ storage });
      const { bytes, reported, error } = await run(ctx);

      expect(error).toBeUndefined();
      expectNativeArrow(ctx, bytes);
      expect(ctx.storage.gets()).toBe(1);
      expect(ctx.executions.at(-1)).toBe("INLINE+JSON_ARRAY");
      expect(reported).not.toContain("links-denied");
    },
  );

  test("with the links-denied hint the query goes inline and storage is not touched", async () => {
    const ctx = await setup({ storage: { kind: "status", status: 403 } });
    const { bytes, error } = await run(ctx, "links-denied");

    expect(error).toBeUndefined();
    expectNativeArrow(ctx, bytes);
    expect(ctx.executions).toEqual(["INLINE+JSON_ARRAY"]);
    expect(ctx.storage.gets()).toBe(0);
  });

  test("a refusal that is followed by an unrelated inline failure surfaces that failure unchanged", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      inline: () => {
        throw ExecutionError.statementFailed(
          "User does not have SELECT on catalog.schema.table",
          "PERMISSION_DENIED",
          "You do not have permission to run this query.",
        );
      },
    });
    const { error } = await run(ctx);

    expect(error?.errorCode).toBe("PERMISSION_DENIED");
    expect(error?.clientMessage).toBe(
      "You do not have permission to run this query.",
    );
  });

  test("a refused download of a result too large for inline fails saying why, without running inline", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      totalByteCount: LARGE,
    });
    const { error, reported } = await run(ctx);

    expect(error?.errorCode).toBe("EXTERNAL_LINKS_DENIED");
    expect(error?.clientMessage).toMatch(/workspace storage/);
    expect(error?.clientMessage).toMatch(/too large to send inline/);
    expect(error?.clientMessage).not.toMatch(/azure/i);
    expect(ctx.executions).toEqual([
      "INLINE+ARROW_STREAM",
      "EXTERNAL_LINKS+ARROW_STREAM",
    ]);
    expect(reported.at(-1)).toBe("links-denied");
  });

  test("a slow first byte on a large result gets one patient pass instead of a denial", async () => {
    const ctx = await setup({
      storage: { kind: "ok", delayMs: 300 },
      totalByteCount: LARGE,
    });
    const { bytes, reported, error } = await run(ctx);

    expect(error).toBeUndefined();
    expect(Buffer.from(ctx.data.ipc).equals(bytes)).toBe(true);
    expect(ctx.storage.gets()).toBe(2);
    expect(ctx.executions).not.toContain("INLINE+JSON_ARRAY");
    expect(reported).not.toContain("links-denied");
  });

  test("a large result whose storage never answers fails saying why after the patient pass", async () => {
    const ctx = await setup({
      storage: { kind: "hang" },
      totalByteCount: LARGE,
    });
    const { error, reported } = await run(ctx);

    expect(error?.errorCode).toBe("EXTERNAL_LINKS_DENIED");
    expect(ctx.storage.gets()).toBe(2);
    expect(ctx.executions).not.toContain("INLINE+JSON_ARRAY");
    expect(reported.at(-1)).toBe("links-denied");
  });

  test("an inline result that spans several chunks is not served truncated", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      inline: () => ({
        statement_id: "stmt-json",
        columns: typedDataset().columns,
        dataArray: typedDataset().dataArray.slice(0, 3),
        nextChunkIndex: 1,
      }),
    });
    const { error } = await run(ctx);

    expect(error?.errorCode).toBe("EXTERNAL_LINKS_DENIED");
  });

  test("with the links-denied hint, a result too big for inline still downloads once storage recovers", async () => {
    const ctx = await setup({
      inline: () => ({
        statement_id: "stmt-json",
        columns: typedDataset().columns,
        dataArray: [],
        nextChunkIndex: 1,
      }),
    });
    const { bytes, reported, error } = await run(ctx, "links-denied");

    expect(error).toBeUndefined();
    expect(Buffer.from(ctx.data.ipc).equals(bytes)).toBe(true);
    expect(ctx.executions).toEqual([
      "INLINE+JSON_ARRAY",
      "EXTERNAL_LINKS+ARROW_STREAM",
    ]);
    expect(ctx.storage.gets()).toBe(1);
    expect(reported.at(-1)).toBe("external");
  });

  test("with the links-denied hint, a too-big result while storage still refuses fails saying why", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      inline: () => ({
        statement_id: "stmt-json",
        columns: typedDataset().columns,
        dataArray: [],
        nextChunkIndex: 1,
      }),
    });
    const { error } = await run(ctx, "links-denied");

    expect(error?.errorCode).toBe("EXTERNAL_LINKS_DENIED");
  });

  test("with the links-denied hint, an unrelated inline failure is what the user sees when storage still refuses", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      inline: () => {
        throw ExecutionError.statementFailed(
          "warehouse is restarting",
          "TEMPORARILY_UNAVAILABLE",
        );
      },
    });
    const { error } = await run(ctx, "links-denied");

    expect(error?.errorCode).toBe("TEMPORARILY_UNAVAILABLE");
  });

  test("a result the rebuild cannot parse fails with a code and a message, not a generic error", async () => {
    const ctx = await setup({
      storage: { kind: "status", status: 403 },
      inline: () => ({
        statement_id: "stmt-json",
        columns: [{ name: "n", typeName: "INT", typeText: "INT" }],
        dataArray: [["not-a-number"]],
      }),
    });
    const { error } = await run(ctx);

    expect(error?.errorCode).toBe("ARROW_REBUILD_FAILED");
    expect(error?.clientMessage).toMatch(/JSON_ARRAY/);
  });
});
