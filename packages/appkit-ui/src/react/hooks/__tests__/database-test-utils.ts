import { vi } from "vitest";

import { _resetConfigCache } from "@/js/config";
import type { DatabaseApiError } from "@/js/database/errors";

import {
  invalidateDatabaseReads as typedInvalidateDatabaseReads,
  resetDatabaseRequestStore,
} from "../database-request-store";
import { useDatabaseCreate as typedUseDatabaseCreate } from "../use-database-create";
import { useDatabaseDelete as typedUseDatabaseDelete } from "../use-database-delete";
import { useDatabaseList as typedUseDatabaseList } from "../use-database-list";
import type { UseDatabaseReadResult } from "../use-database-read";
import { useDatabaseRecord as typedUseDatabaseRecord } from "../use-database-record";
import { useDatabaseUpdate as typedUseDatabaseUpdate } from "../use-database-update";
import type { UseDatabaseWriteState } from "../use-database-write";

// This package has no generated registry, so every entity name is `never`
// here. The typed surface is compiled in use-database.types.test.ts; the
// runtime tests drive the hooks through these string-typed views.

export type Row = Record<string, unknown>;
type Page = { items: unknown[]; limit: number; offset: number };

interface ReadOptions {
  enabled?: boolean;
  keepPreviousData?: boolean;
  shape?: (row: unknown) => unknown;
}

interface WriteOptions<Args extends unknown[], T> {
  invalidate?: boolean | readonly string[];
  onSuccess?: (result: T, ...args: Args) => void;
  onError?: (error: DatabaseApiError, ...args: Args) => void;
}

type Id = string | number | bigint;

export const useDatabaseList = typedUseDatabaseList as unknown as (
  entity: string,
  params?: object | null,
  options?: ReadOptions,
) => UseDatabaseReadResult<Page>;

export const useDatabaseRecord = typedUseDatabaseRecord as unknown as (
  entity: string,
  id: Id | null | undefined,
  params?: object,
  options?: ReadOptions,
) => UseDatabaseReadResult<Row>;

export const useDatabaseCreate = typedUseDatabaseCreate as unknown as (
  entity: string,
  options?: WriteOptions<[values: object], Row>,
) => UseDatabaseWriteState<Row> & {
  create(values: object): Promise<Row | null>;
  reset(): void;
};

export const useDatabaseUpdate = typedUseDatabaseUpdate as unknown as (
  entity: string,
  options?: WriteOptions<[id: Id, values: object], Row>,
) => UseDatabaseWriteState<Row> & {
  update(id: Id, values: object): Promise<Row | null>;
  reset(): void;
};

export const useDatabaseDelete = typedUseDatabaseDelete as unknown as (
  entity: string,
  options?: {
    invalidate?: boolean | readonly string[];
    onSuccess?: (id: Id) => void;
    onError?: (error: DatabaseApiError, id: Id) => void;
  },
) => {
  remove(id: Id): Promise<boolean>;
  loading: boolean;
  error: DatabaseApiError | null;
  reset(): void;
};

export const invalidateDatabaseReads = typedInvalidateDatabaseReads as (
  scope?: boolean | readonly string[],
) => Promise<void>;

/** One request the mocked `fetch` holds open until the test answers it. */
export interface PendingRequest {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | undefined;
  respond(body: unknown, status?: number): void;
}

export function reply(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function page(...items: unknown[]): Page {
  return { items, limit: 50, offset: 0 };
}

/**
 * Stub `fetch` so every request stays open until the test answers it, which
 * lets a test control the order completions arrive in. Aborts are ignored, so
 * a test can deliver a completion after its request was superseded.
 */
export function mockDatabaseFetch() {
  const requests: PendingRequest[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve) => {
        requests.push({
          url,
          method: init.method ?? "GET",
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
          signal: init.signal ?? undefined,
          respond: (body, status) => resolve(reply(body, status)),
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  /** Requests sent with `method`, in order. */
  const sent = (method: string) =>
    requests.filter((request) => request.method === method);
  return { requests, fetchMock, sent };
}

/** Publish database routes, and optionally relations, as the server would. */
export function publishDatabase(
  endpoints: Record<string, string>,
  relations?: Record<string, Record<string, string>>,
): void {
  window.__appkit__ = {
    appName: "test",
    queries: {},
    endpoints: { database: endpoints },
    plugins: relations ? { database: { relations } } : {},
  };
  _resetConfigCache();
  resetDatabaseRequestStore();
}

export function resetDatabaseTestEnvironment(): void {
  vi.unstubAllGlobals();
  delete window.__appkit__;
  _resetConfigCache();
  resetDatabaseRequestStore();
}

/** Let the deferred teardown of a released entry run. */
export const nextTick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
