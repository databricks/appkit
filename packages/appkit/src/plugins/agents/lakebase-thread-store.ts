import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import type { Message, Thread, ThreadStore, ToolCall } from "shared";

import { createLakebasePool } from "../../connectors/lakebase";

/** Postgres identifier: lowercase, digits, underscore, not leading with a digit. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface LakebaseThreadStoreOptions {
  /**
   * An existing `pg.Pool` to run on. When omitted, the store creates its own
   * pool via `createLakebasePool()` (OAuth token refresh handled inside) and
   * closes it on {@link LakebaseThreadStore.close}. An injected pool is never
   * closed — the caller owns its lifecycle.
   */
  pool?: Pool;
  /**
   * Optional Postgres schema to hold the two tables. Created on init if it
   * does not exist. Defaults to the connection's search_path (usually
   * `public`). Validated as a plain lowercase identifier — it is interpolated
   * into DDL, not parameterizable, so anything else is rejected.
   */
  tableSchema?: string;
}

interface ThreadRow {
  id: string;
  user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MessageRow {
  thread_id: string;
  id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: ToolCall[] | null;
  created_at: string | Date;
}

/**
 * Persistent {@link ThreadStore} backed by Databricks Lakebase (Postgres).
 *
 * Threads and messages live in two `user_id`-scoped tables (`agent_threads`,
 * `agent_messages`, FK cascade). The app service principal owns the tables;
 * **every** query filters `WHERE user_id = $` — that is the isolation
 * boundary, so a user can never read or mutate another user's threads.
 *
 * The schema is self-bootstrapping: {@link init} issues idempotent
 * `CREATE TABLE IF NOT EXISTS` (once-guarded) and verifies connectivity, so
 * a fresh Lakebase database works with no migration step.
 *
 * Pass it to the agents plugin for a deployment that survives restarts:
 * ```ts
 * agents({ threadStore: new LakebaseThreadStore() })
 * ```
 */
export class LakebaseThreadStore implements ThreadStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly threads: string;
  private readonly messages: string;
  private readonly schema?: string;
  private initPromise: Promise<void> | null = null;

  constructor({ pool, tableSchema }: LakebaseThreadStoreOptions = {}) {
    this.ownsPool = !pool;
    this.pool = pool ?? createLakebasePool();
    if (tableSchema !== undefined && !IDENTIFIER.test(tableSchema)) {
      throw new Error(
        `LakebaseThreadStore: invalid tableSchema "${tableSchema}" (expected a lowercase identifier)`,
      );
    }
    this.schema = tableSchema;
    const prefix = tableSchema ? `${tableSchema}.` : "";
    this.threads = `${prefix}agent_threads`;
    this.messages = `${prefix}agent_messages`;
  }

  /** Verify connectivity and create the tables once (idempotent). */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.bootstrap();
    return this.initPromise;
  }

  /** Close the pool only when this store created it. */
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async bootstrap(): Promise<void> {
    // Fail fast on an unauthenticated/unreachable pool before the DDL, mirroring
    // the DatabasePlugin readiness probe.
    await this.pool.query("select 1");
    if (this.schema) {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.threads} (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS agent_threads_user_updated_idx ON ${this.threads} (user_id, updated_at DESC)`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.messages} (
        seq bigserial PRIMARY KEY,
        id text NOT NULL,
        thread_id uuid NOT NULL REFERENCES ${this.threads}(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        role text NOT NULL,
        content text NOT NULL,
        tool_call_id text,
        tool_calls jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS agent_messages_thread_seq_idx ON ${this.messages} (thread_id, seq)`,
    );
  }

  async create(userId: string): Promise<Thread> {
    const id = randomUUID();
    const { rows } = await this.pool.query<ThreadRow>(
      `INSERT INTO ${this.threads} (id, user_id)
       VALUES ($1, $2)
       RETURNING id, user_id, created_at, updated_at`,
      [id, userId],
    );
    return this.toThread(rows[0], []);
  }

  async get(threadId: string, userId: string): Promise<Thread | null> {
    const threadResult = await this.pool.query<ThreadRow>(
      `SELECT id, user_id, created_at, updated_at
       FROM ${this.threads}
       WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    );
    const row = threadResult.rows[0];
    if (!row) return null;

    const messageResult = await this.pool.query<MessageRow>(
      `SELECT thread_id, id, role, content, tool_call_id, tool_calls, created_at
       FROM ${this.messages}
       WHERE thread_id = $1 AND user_id = $2
       ORDER BY seq`,
      [threadId, userId],
    );
    return this.toThread(row, messageResult.rows.map(toMessage));
  }

  async list(userId: string): Promise<Thread[]> {
    const threadResult = await this.pool.query<ThreadRow>(
      `SELECT id, user_id, created_at, updated_at
       FROM ${this.threads}
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );
    if (threadResult.rows.length === 0) return [];

    // One query for every message this user owns, grouped in-app by thread —
    // avoids an N+1 across their threads.
    const messageResult = await this.pool.query<MessageRow>(
      `SELECT thread_id, id, role, content, tool_call_id, tool_calls, created_at
       FROM ${this.messages}
       WHERE user_id = $1
       ORDER BY thread_id, seq`,
      [userId],
    );
    const byThread = new Map<string, Message[]>();
    for (const row of messageResult.rows) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(toMessage(row));
      byThread.set(row.thread_id, list);
    }
    return threadResult.rows.map((row) =>
      this.toThread(row, byThread.get(row.id) ?? []),
    );
  }

  async addMessage(
    threadId: string,
    userId: string,
    message: Message,
  ): Promise<void> {
    // Single atomic statement: bump the thread's updated_at only if it exists
    // for this user, then insert the message off that CTE. When the thread row
    // is absent (unknown id, or owned by another user) `updated` is empty, the
    // INSERT ... SELECT writes zero rows, and we throw — matching InMemory.
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE ${this.threads} SET updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id
       )
       INSERT INTO ${this.messages}
         (id, thread_id, user_id, role, content, tool_call_id, tool_calls)
       SELECT $3::text, $1::uuid, $2::text, $4::text, $5::text, $6::text, $7::jsonb
       FROM updated`,
      [
        threadId,
        userId,
        message.id,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Thread ${threadId} not found`);
    }
  }

  async delete(threadId: string, userId: string): Promise<boolean> {
    // Messages cascade via the FK.
    const result = await this.pool.query(
      `DELETE FROM ${this.threads} WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private toThread(row: ThreadRow, messages: Message[]): Thread {
    return {
      id: row.id,
      userId: row.user_id,
      messages,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

/** Reconstruct a `Message`, reviving its Date and passing tool_calls verbatim. */
function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    role: row.role as Message["role"],
    content: row.content,
    createdAt: new Date(row.created_at),
  };
  if (row.tool_call_id != null) message.toolCallId = row.tool_call_id;
  // jsonb is parsed to a JS value by node-pg, so `thoughtSignature` (and every
  // other ToolCall field) survives the round trip unchanged.
  if (row.tool_calls != null) message.toolCalls = row.tool_calls;
  return message;
}
