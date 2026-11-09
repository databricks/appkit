import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Bool,
  DateDay,
  Decimal,
  Float64,
  Int32,
  Int64,
  makeData,
  makeVector,
  type Table,
  Table as ArrowTable,
  TimestampMicrosecond,
  tableToIPC,
  Utf8,
  vectorFromArray,
} from "apache-arrow";

/** A standard SQL warehouse's view of one result: manifest columns, JSON rows, native Arrow. */
export interface Dataset {
  columns: Array<{
    name: string;
    typeName: string;
    typeText: string;
    position: number;
    typePrecision?: number;
    typeScale?: number;
  }>;
  /** Positional string rows, exactly as INLINE + JSON_ARRAY returns them. */
  dataArray: Array<Array<string | null>>;
  /** The IPC stream Cloud Fetch serves for the same result. */
  ipc: Uint8Array;
}

const DAY = 86_400_000;
const isNull = (row: number, col: number) => (row + col) % 7 === 3;

function decimalVector(unscaled: Array<bigint | null>, scale: number) {
  const words = new Uint32Array(unscaled.length * 4);
  const validity = new Uint8Array(Math.ceil(unscaled.length / 8));
  let nullCount = 0;
  unscaled.forEach((v, i) => {
    if (v === null) {
      nullCount++;
      return;
    }
    validity[i >> 3] |= 1 << (i & 7);
    const twos = v < 0n ? (1n << 128n) + v : v;
    for (let w = 0; w < 4; w++) {
      words[i * 4 + w] = Number((twos >> BigInt(32 * w)) & 0xffffffffn);
    }
  });
  return makeVector(
    makeData({
      type: new Decimal(scale, 10, 128),
      length: unscaled.length,
      nullCount,
      nullBitmap: validity,
      data: words,
    }),
  );
}

const fixed = (v: bigint) => {
  const sign = v < 0n ? "-" : "";
  const digits = (v < 0n ? -v : v).toString().padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Eight scalar types with nulls sprinkled through every column. */
export function typedDataset(rows = 20): Dataset {
  const col = <T>(c: number, f: (i: number) => T) =>
    Array.from({ length: rows }, (_, i) => (isNull(i, c) ? null : f(i)));
  const id = col(0, (i) => i);
  const big = col(1, (i) => 9007199254740993n + BigInt(i));
  const amount = col(2, (i) => i * 1.5);
  const price = col(3, (i) => BigInt(i * 101 - 50));
  const day = col(4, (i) => Date.UTC(2026, 0, 1) + i * DAY);
  const ts = col(5, (i) => Date.UTC(2026, 0, 1, 10) + i * 3_600_000);
  const label = col(6, (i) => `row-${i}`);
  const flag = col(7, (i) => i % 2 === 0);

  const table = new ArrowTable({
    id: vectorFromArray(id, new Int32()),
    big: vectorFromArray(big, new Int64()),
    amount: vectorFromArray(amount, new Float64()),
    price: decimalVector(price, 2),
    day: vectorFromArray(day, new DateDay()),
    ts: vectorFromArray(ts, new TimestampMicrosecond("UTC")),
    label: vectorFromArray(label, new Utf8()),
    flag: vectorFromArray(flag, new Bool()),
  });

  const text = (v: unknown, render: (x: never) => string) =>
    v === null ? null : render(v as never);
  const dataArray = Array.from({ length: rows }, (_, i) => [
    text(id[i], String),
    text(big[i], String),
    text(amount[i], String),
    text(price[i], fixed),
    text(day[i], (x: number) => new Date(x).toISOString().slice(0, 10)),
    text(ts[i], (x: number) => new Date(x).toISOString()),
    text(label[i], String),
    text(flag[i], String),
  ]);

  const column = (
    name: string,
    typeName: string,
    typeText: string,
    position: number,
    extra: { typePrecision?: number; typeScale?: number } = {},
  ) => ({ name, typeName, typeText, position, ...extra });
  return {
    columns: [
      column("id", "INT", "INT", 0),
      column("big", "LONG", "BIGINT", 1),
      column("amount", "DOUBLE", "DOUBLE", 2),
      column("price", "DECIMAL", "DECIMAL(10,2)", 3, {
        typePrecision: 10,
        typeScale: 2,
      }),
      column("day", "DATE", "DATE", 4),
      column("ts", "TIMESTAMP", "TIMESTAMP", 5),
      column("label", "STRING", "STRING", 6),
      column("flag", "BOOLEAN", "BOOLEAN", 7),
    ],
    dataArray,
    ipc: tableToIPC(table, "stream"),
  };
}

/** Every cell as a string, so schemas and values compare across Arrow builds. */
export function cellsOf(table: Table): Array<Array<string | null>> {
  const columns = table.schema.fields.map((_f, index) =>
    [...(table.getChildAt(index) as Iterable<unknown>)].map((v) =>
      v === null || v === undefined ? null : String(v),
    ),
  );
  return Array.from({ length: table.numRows }, (_, i) =>
    columns.map((c) => c[i]),
  );
}

export function schemaOf(table: Table): string[] {
  return table.schema.fields.map((f) => `${f.name}:${String(f.type)}`);
}

export type StorageMode =
  | { kind: "ok"; delayMs?: number }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "hang-after-headers" }
  | { kind: "reset-after-headers" };

export interface FakeStorage {
  /** GETs received, whatever the answer. */
  readonly gets: () => number;
  readonly requestHeaders: IncomingMessage["headers"][];
  url(path?: string): string;
  setMode(mode: StorageMode): void;
  /** Body served on a healthy GET. */
  setBody(bytes: Uint8Array): void;
  close(): Promise<void>;
}

/** A loopback host standing in for workspace storage behind a presigned URL. */
export async function startStorage(
  initial: StorageMode = { kind: "ok" },
): Promise<FakeStorage> {
  let mode = initial;
  let body: Uint8Array = new Uint8Array();
  let gets = 0;
  const requestHeaders: IncomingMessage["headers"][] = [];
  const server: Server = createServer((req, res) => {
    gets++;
    requestHeaders.push(req.headers);
    const current = mode;
    switch (current.kind) {
      case "ok":
        setTimeout(() => res.end(Buffer.from(body)), current.delayMs ?? 0);
        return;
      case "status":
        res.writeHead(current.status).end("denied");
        return;
      case "hang":
        return;
      case "hang-after-headers":
        res.writeHead(200, { "content-length": 100_000 });
        res.flushHeaders();
        return;
      case "reset-after-headers":
        res.writeHead(200, { "content-length": 100_000 });
        res.flushHeaders();
        setTimeout(() => req.socket.destroy(), 30);
        return;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    gets: () => gets,
    requestHeaders,
    url: (path = "chunk") => `${base}/${path}`,
    setMode: (next) => {
      mode = next;
    },
    setBody: (bytes) => {
      body = bytes;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
