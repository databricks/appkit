import type { PoolClient } from "pg";

import { schemaOwnership } from "../migrations/ownership";
import { type DbContext, withBranchPool } from "./context";
import type { LakebaseRole } from "./lakebase-api";
import { resourceId } from "./targets";

/**
 * What keeps a role from being dropped once its objects in the current
 * database are reassigned: objects it owns in other databases, shared objects
 * (databases), and privileges granted to it anywhere.
 */
const BLOCKERS_SQL = `
select coalesce(d.datname, '') as database, count(*)::int as count
  from pg_catalog.pg_shdepend s
  left join pg_catalog.pg_database d on d.oid = s.dbid
 where s.refclassid = 'pg_catalog.pg_authid'::regclass
   and s.refobjid = (select oid from pg_catalog.pg_roles where rolname = $1)
   and not (s.deptype = 'o' and s.dbid = (select oid from pg_catalog.pg_database
                                          where datname = current_database()))
 group by 1
 order by 1`;

interface RoleBlocker {
  /** Empty for shared objects. */
  readonly database: string;
  readonly count: number;
}

export async function readRoleBlockers(
  client: Pick<PoolClient, "query">,
  role: string,
): Promise<RoleBlocker[]> {
  const { rows } = await client.query<RoleBlocker>(BLOCKERS_SQL, [role]);
  return rows;
}

function describeBlockers(blockers: readonly RoleBlocker[]): string {
  return blockers
    .map(
      ({ database, count }) =>
        `${database ? `database ${database}` : "shared objects"} (${count})`,
    )
    .join(", ");
}

interface HandOff {
  /** The branch .env points at. */
  readonly branch: string;
  readonly database: string;
  readonly schemaName: string;
  /** Your role on the branch, which receives the objects. */
  readonly developer: LakebaseRole;
  readonly roles: readonly LakebaseRole[];
  readonly onStep: (message: string) => void;
}

/**
 * A fork copies its parent's objects with their owners, so on a fork of the
 * deploy branch the app's service principal owns the app schema. Hand it to
 * you by deleting that owner's copy of its role on this branch, with its
 * objects reassigned to you. Only the app schema's owner is deleted. Returns
 * that owner; null when you already own the schema or it does not exist.
 */
export async function handOffAppSchema(
  ctx: DbContext,
  input: HandOff,
): Promise<string | null> {
  const found = await withBranchPool(ctx, async (pool) => {
    const { owner, currentUser } = await schemaOwnership(
      pool,
      input.schemaName,
    );
    if (!owner || owner === currentUser) return null;
    return { owner, blockers: await readRoleBlockers(pool, owner) };
  });
  if (!found) return null;

  const { owner, blockers } = found;
  const where = `schema ${input.schemaName} in database ${input.database} on ${resourceId(input.branch)}`;
  const role = input.roles.find((r) => r.status?.postgres_role === owner);
  if (!role) {
    throw new Error(
      `Cannot hand ${where} to you: it belongs to "${owner}", which is not a Lakebase-managed role. .env already points at the branch. Have "${owner}" transfer the schema and its objects to you (ALTER … OWNER TO), or set another schemaName in schema.ts, then rerun \`appkit db init\`.`,
    );
  }
  input.onStep(
    `Handing ${where} to you: deleting this branch's copy of role ${owner}, which owns it, with its objects reassigned to you`,
  );
  try {
    await ctx
      .api()
      .deleteRole(role.name, { reassignOwnedTo: input.developer.name });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      blockers.length > 0
        ? `Could not hand ${where} to you: deleting role "${owner}" failed (${reason}). These objects and privileges of "${owner}" block the delete: ${describeBlockers(blockers)}. .env already points at the branch. Drop them or reassign them to you, then rerun \`appkit db init\`.`
        : `Could not hand ${where} to you: deleting role "${owner}" failed (${reason}). .env already points at the branch; rerun \`appkit db init\` to retry.`,
      { cause: error },
    );
  }
  return owner;
}
