import { Table, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";
import { describe, expect, test, vi } from "vitest";
import { ExecutionError } from "../../../errors";
import {
  type ArrowChunkStreamer,
  arrowDeliveryUnsupported,
  classifyDispositionRejection,
  decodeArrowAttachmentToRows,
  deliverArrowBytes,
  deliverJsonResult,
  type QueryExecutor,
} from "../result-delivery";

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
