import type { PoolClient } from "pg";

import {
  journalRefusal,
  type JournalUse,
  quoteIdentifier,
  readJournalRelation,
} from "../migrations/apply";
import { schemaOwnership } from "../migrations/ownership";
import { MIGRATIONS_TABLE } from "../migrations/paths";
import { readKeptObjects } from "./clean";
import { shown } from "./introspect/render";
import { resourceId } from "./targets";

export type SchemaStart = "migrate" | "introspect" | "clean" | "none";

export const FORK_COPY_TAG = "appkit:fork-copy";

export type SchemaState =
  | { readonly kind: "absent" }
  | { readonly kind: "copy"; readonly owner: string }
  | { readonly kind: "interrupted-rebuild" }
  | { readonly kind: "yours" }
  | { readonly kind: "public"; readonly kept: readonly string[] };

type QueryClient = Pick<PoolClient, "query">;

const journalTable = (schemaName: string) =>
  `${quoteIdentifier(schemaName)}.${quoteIdentifier(MIGRATIONS_TABLE)}`;

async function journalUsable(
  client: QueryClient,
  schemaName: string,
  use: JournalUse,
): Promise<boolean> {
  const relation = await readJournalRelation(client, schemaName);
  return relation !== null && journalRefusal(relation, use) === undefined;
}

export async function isForkCopy(
  client: QueryClient,
  schemaName: string,
): Promise<boolean> {
  if (!(await journalUsable(client, schemaName, "read"))) return false;
  const { rows } = await client.query(
    `select 1 from ${journalTable(schemaName)} where hash = $1 limit 1`,
    [FORK_COPY_TAG],
  );
  return rows.length > 0;
}

/**
 * Tag the copied journal. On Lakebase your role can insert into the service
 * principal's tables before the hand-off. Returns false when the schema has no
 * journal the trust rule lets you write, which leaves the hand-off and the
 * clean unmarked between them.
 */
export async function tagForkCopy(
  client: QueryClient,
  schemaName: string,
): Promise<boolean> {
  if (!(await journalUsable(client, schemaName, "record"))) return false;
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
  if (!(await journalUsable(client, schemaName, "record"))) return;
  await client.query(
    `delete from ${journalTable(schemaName)} where hash = $1`,
    [FORK_COPY_TAG],
  );
}

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
    ? { kind: "interrupted-rebuild" }
    : { kind: "yours" };
}

export interface StartPlan {
  readonly kind: Exclude<SchemaStart, "none">;
  readonly rebuild: boolean;
  readonly tag: boolean;
  readonly handOff: boolean;
  readonly keepsCopy: boolean;
  readonly confirm: boolean;
}

const NOTHING_ELSE = {
  rebuild: false,
  tag: false,
  handOff: false,
  keepsCopy: false,
} as const;

function holdsForkCopy(state: SchemaState, forkedThisRun: boolean): boolean {
  return (
    state.kind === "copy" ||
    state.kind === "interrupted-rebuild" ||
    (state.kind === "yours" && forkedThisRun)
  );
}

function mayHoldYourWork(state: SchemaState, forkedThisRun: boolean): boolean {
  return state.kind !== "absent" && !holdsForkCopy(state, forkedThisRun);
}

export function planStart(
  state: SchemaState,
  requested: Exclude<SchemaStart, "none"> | undefined,
  hasSchema: boolean,
  forkedThisRun = false,
): StartPlan {
  if (!holdsForkCopy(state, forkedThisRun)) {
    const kind = requested ?? (hasSchema ? "migrate" : "introspect");
    return {
      ...NOTHING_ELSE,
      kind,
      rebuild: kind === "clean",
      confirm: kind === "clean" && mayHoldYourWork(state, forkedThisRun),
    };
  }
  const untouched = state.kind === "copy";
  const interrupted = state.kind === "interrupted-rebuild";
  if (requested === "migrate" || requested === "introspect") {
    return {
      ...NOTHING_ELSE,
      kind: requested,
      handOff: untouched,
      keepsCopy: true,
      confirm: false,
    };
  }
  return {
    ...NOTHING_ELSE,
    kind: requested ?? (hasSchema ? "clean" : "introspect"),
    rebuild: true,
    tag: !interrupted,
    handOff: untouched,
    confirm: false,
  };
}

export function forkCopyRefusal(
  branch: string,
  schemaName: string,
  state: SchemaState,
  keep: "migrate" | "introspect",
): string | undefined {
  if (state.kind !== "copy" && state.kind !== "interrupted-rebuild") {
    return undefined;
  }
  const holds =
    state.kind === "copy"
      ? `which "${shown(state.owner)}" still owns`
      : "and its rebuild did not finish";
  return `${resourceId(branch)} still holds the rows the fork copied into schema "${schemaName}", ${holds}. Run \`appkit db init\` to rebuild it from the committed migrations, or \`appkit db init --schema ${keep}\` to keep them.`;
}
