import { vi } from "vitest";

import type {
  ExportLogsServiceRequest,
  OtlpLogRecord,
} from "../core/otlp-json";

export function installFetchMock() {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function readPayload(
  request: RequestInit | undefined,
): ExportLogsServiceRequest {
  if (typeof request?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(request.body) as ExportLogsServiceRequest;
}

export function readFirstLogRecord(
  payload: ExportLogsServiceRequest,
): OtlpLogRecord {
  const record = readLogRecords(payload)[0];
  if (record === undefined) throw new Error("Expected one OTLP log record");
  return record;
}

export function readLogRecords(
  payload: ExportLogsServiceRequest,
): OtlpLogRecord[] {
  return payload.resourceLogs.flatMap(({ scopeLogs }) =>
    scopeLogs.flatMap(({ logRecords }) => logRecords),
  );
}

export function readStringAttribute(
  record: OtlpLogRecord,
  key: string,
): string {
  const value = record.attributes.find(
    (attribute) => attribute.key === key,
  )?.value;
  if (value === undefined || !("stringValue" in value)) {
    throw new Error(`Expected ${key} to be a string attribute`);
  }
  return value.stringValue;
}
