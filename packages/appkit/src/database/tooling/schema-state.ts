import type { PoolClient } from "pg";

import { quoteIdentifier } from "../migrations/apply";
import { schemaOwnership } from "../migrations/ownership";
import { MIGRATIONS_TABLE } from "../migrations/paths";
import { readKeptObjects } from "./clean";
import { resourceId } from "./targets";

/** How init leaves the schema; "none" leaves it as the fork has it. */
export type SchemaStart = "migrate" | "introspect" | "clean" | "none";

/**
 * The journal row init writes into a fork's copy of the app schema before it
 * takes the schema over. The clean drops it with the schema, so a rerun from
 * any checkout reads from the branch itself whether a rebuild is still due.
 */
export const FORK_COPY_TAG = "appkit:fork-copy";

/** What the app schema on the branch is, read from the branch itself. */
export type SchemaState =
  /** Nothing copied and nothing built yet. */
  | { readonly kind: "absent" }
  /** The fork's untouched copy: another role, the app's service principal, owns it. */
  | { readonly kind: "copy"; readonly owner: string }
  /** Handed to you and still tagged: a rebuild stopped before its clean. */
  | { readonly kind: "handed-off-copy" }
  /** Your working branch. */
  | { readonly kind: "yours" }
  /**
   * Schema public belongs to the database, never to an app, so it is never
   * handed off or tagged. What other roles own in it stays with its rows.
   */
  | { readonly kind: "public"; readonly kept: readonly string[] };

type QueryClient = Pick<PoolClient, "query">;

const journalTable = (schemaName: string) =>
  `${quoteIdentifier(schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`;

/**
 * Whether an ordinary table stands at the journal's name. Anything else there
 * is left alone: the migrator refuses it with its own message.
 */
async function hasJournalTable(
  client: QueryClient,
  schemaName: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'`,
    [schemaName, MIGRATIONS_TABLE],
  );
  return rows.length > 0;
}

/** Whether the branch's journal carries the fork-copy tag. */
export async function isForkCopy(
  client: QueryClient,
  schemaName: string,
): Promise<boolean> {
  if (!(await hasJournalTable(client, schemaName))) return false;
  const { rows } = await client.query(
    `select 1 from ${journalTable(schemaName)} where hash = $1 limit 1`,
    [FORK_COPY_TAG],
  );
  return rows.length > 0;
}

/**
 * Tag the copied journal. On Lakebase your role can insert into the service
 * principal's tables before the hand-off. Returns false when the schema has no
 * journal to tag, which leaves the hand-off and the clean unmarked between them.
 */
export async function tagForkCopy(
  client: QueryClient,
  schemaName: string,
): Promise<boolean> {
  if (!(await hasJournalTable(client, schemaName))) return false;
  const journal = journalTable(schemaName);
  await client.query(
    `insert into ${journal} (hash, created_at)
     select $1, 0 where not exists (select 1 from ${journal} where hash = $1)`,
    [FORK_COPY_TAG],
  );
  return true;
}

export async function untagForkCopy(
  client: QueryClient,
  schemaName: string,
): Promise<void> {
  if (!(await hasJournalTable(client, schemaName))) return;
  await client.query(
    `delete from ${journalTable(schemaName)} where hash = $1`,
    [FORK_COPY_TAG],
  );
}

/** Read the app schema's state as the connected developer. */
export async function readSchemaState(
  client: QueryClient,
  schemaName: string,
): Promise<SchemaState> {
  if (schemaName === "public") {
    return { kind: "public", kept: await readKeptObjects(client, "public") };
  }
  const { owner, currentUser } = await schemaOwnership(client, schemaName);
  if (owner === null) return { kind: "absent" };
  if (owner !== currentUser) return { kind: "copy", owner };
  return (await isForkCopy(client, schemaName))
    ? { kind: "handed-off-copy" }
    : { kind: "yours" };
}

/** What init does with the schema, decided once from its state and the request. */
export interface StartPlan {
  readonly kind: Exclude<SchemaStart, "none">;
  /** Drop the app schema, then apply the committed migrations, so a copy's rows go. */
  readonly rebuild: boolean;
  /** Tag the copied journal before the hand-off, so a rerun from any checkout finishes the rebuild. */
  readonly tag: boolean;
  /** Delete the copy's owner on this branch, with its objects reassigned to you. */
  readonly handOff: boolean;
  /** You asked to keep a copy's rows: the tag goes and the rows stay. */
  readonly keepsCopy: boolean;
  /** An explicit clean of what may be your work asks first. */
  readonly confirm: boolean;
}

const NOTHING_ELSE = {
  rebuild: false,
  tag: false,
  handOff: false,
  keepsCopy: false,
  confirm: false,
} as const;

/**
 * Without a request, a copy is rebuilt and your working branch is migrated,
 * each with schema.ts, else introspected. A copy's rows stay only on request.
 * A rebuild of a copy needs no confirmation: `appkit db migrate` refuses a
 * tagged branch, so none of your work can be on it.
 */
export function planStart(
  state: SchemaState,
  requested: Exclude<SchemaStart, "none"> | undefined,
  hasSchema: boolean,
): StartPlan {
  switch (state.kind) {
    case "copy":
    case "handed-off-copy": {
      const untouched = state.kind === "copy";
      if (requested === "migrate" || requested === "introspect") {
        return {
          ...NOTHING_ELSE,
          kind: requested,
          handOff: untouched,
          keepsCopy: true,
        };
      }
      if (!untouched && !hasSchema && requested === undefined) {
        throw new Error(
          "The rebuild of the app schema on your branch stopped before it finished, and this checkout has no config/database/schema.ts to rebuild from. Restore schema.ts, then rerun `appkit db init`. `appkit db init --schema introspect` writes schema.ts from the branch and keeps the rows the fork copied.",
        );
      }
      return {
        ...NOTHING_ELSE,
        kind: requested ?? (hasSchema ? "clean" : "introspect"),
        rebuild: true,
        tag: untouched,
        handOff: untouched,
      };
    }
    case "absent":
    case "yours":
    case "public": {
      const kind = requested ?? (hasSchema ? "migrate" : "introspect");
      return {
        ...NOTHING_ELSE,
        kind,
        rebuild: kind === "clean",
        confirm: kind === "clean" && state.kind !== "absent",
      };
    }
  }
}

/** Why a command that writes on the branch refuses one that still holds a fork's copy. */
export function forkCopyRefusal(
  branch: string,
  schemaName: string,
  keep: "migrate" | "introspect",
): string {
  return `${resourceId(branch)} still holds the rows the fork copied into schema "${schemaName}", and its rebuild did not finish. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema ${keep}\` to keep them.`;
}
