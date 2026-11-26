import type { PoolClient } from "pg";

import { schemaOwnership } from "../migrations/ownership";
import { type DbContext, withBranchPool } from "./context";
import { shown } from "./introspect/render";
import type { LakebaseRole } from "./lakebase-api";
import { resourceId } from "./targets";

/**
 * What can keep a role from being dropped once its objects in the current
 * database are reassigned: objects it owns in other databases or shared ones
 * (databases), and privileges granted to it anywhere.
 */
const DEPENDENCIES_SQL = `
select case when s.deptype = 'o' then 'owned' else 'granted' end as kind,
       coalesce(d.datname, '') as database, count(*)::int as count
  from pg_catalog.pg_shdepend s
  left join pg_catalog.pg_database d on d.oid = s.dbid
 where s.refclassid = 'pg_catalog.pg_authid'::regclass
   and s.refobjid = (select oid from pg_catalog.pg_roles where rolname = $1)
   and not (s.deptype = 'o' and s.dbid = (select oid from pg_catalog.pg_database
                                          where datname = current_database()))
 group by 1, 2
 order by 1, 2`;

interface Dependents {
  /** Empty for shared objects. */
  readonly database: string;
  readonly count: number;
}

interface RoleDependencies {
  /** In other databases, or shared objects such as a database. */
  readonly owned: readonly Dependents[];
  readonly granted: readonly Dependents[];
}

export async function readRoleDependencies(
  client: Pick<PoolClient, "query">,
  role: string,
): Promise<RoleDependencies> {
  const { rows } = await client.query<
    Dependents & { kind: "owned" | "granted" }
  >(DEPENDENCIES_SQL, [role]);
  const of = (kind: "owned" | "granted") =>
    rows
      .filter((row) => row.kind === kind)
      .map(({ database, count }) => ({ database: shown(database), count }));
  return { owned: of("owned"), granted: of("granted") };
}

/**
 * What the role owns in the current database besides the app schema and its
 * contents, which a delete with reassign would hand over as well. System
 * schemas are left out; a schema the role owns is listed by name.
 */
const OWNED_OUTSIDE_SQL = `
select o.type || ' ' || o.identity as label
  from pg_catalog.pg_shdepend s
  cross join lateral pg_catalog.pg_identify_object(s.classid, s.objid, s.objsubid) o
 where s.refclassid = 'pg_catalog.pg_authid'::regclass
   and s.refobjid = (select oid from pg_catalog.pg_roles where rolname = $1)
   and s.deptype = 'o'
   and s.dbid = (select oid from pg_catalog.pg_database where datname = current_database())
   and (o.schema is null
        or (o.schema <> $2
            and o.schema not in ('pg_catalog', 'information_schema')
            and o.schema not like 'pg\\_toast%'
            and o.schema not like 'pg\\_temp%'))
   and not (o.type = 'schema' and o.identity = pg_catalog.quote_ident($2))
 order by 1`;

export async function readOwnedOutsideSchema(
  client: Pick<PoolClient, "query">,
  role: string,
  schemaName: string,
): Promise<string[]> {
  const { rows } = await client.query<{ label: string }>(OWNED_OUTSIDE_SQL, [
    role,
    schemaName,
  ]);
  return rows.map((row) => shown(row.label));
}

function describe(dependents: readonly Dependents[]): string {
  return dependents
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
 * objects reassigned to you. Only the app schema's owner is deleted, and only
 * while the app schema is all it owns here: the reassign would hand over its
 * other objects too, so those are listed and the delete is refused. Objects
 * it owns in another database of the branch are refused too, since the
 * reassign cannot reach them. Returns the owner, escaped for display; null
 * when you already own the schema or it does not exist. Schema public is never handed off: it belongs to the database
 * (pg_database_owner on PostgreSQL 15 and later, the bootstrap superuser
 * before), never to an app, so AppKit never deletes its owner or reassigns its
 * objects.
 */
export async function handOffAppSchema(
  ctx: DbContext,
  input: HandOff,
): Promise<string | null> {
  if (input.schemaName === "public") return null;
  const found = await withBranchPool(ctx, async (pool) => {
    const { owner, currentUser } = await schemaOwnership(
      pool,
      input.schemaName,
    );
    if (!owner || owner === currentUser) return null;
    return {
      owner,
      ownedOutside: await readOwnedOutsideSchema(pool, owner, input.schemaName),
      dependencies: await readRoleDependencies(pool, owner),
    };
  });
  if (!found) return null;

  const { owner, ownedOutside, dependencies } = found;
  const ownerName = shown(owner);
  const where = `schema ${input.schemaName} in database ${shown(input.database)} on ${resourceId(input.branch)}`;
  const role = input.roles.find((r) => r.status?.postgres_role === owner);
  if (!role) {
    throw new Error(
      `Cannot hand ${where} to you: it belongs to "${ownerName}", which is not a Lakebase-managed role, and no Postgres role can hand it to you. .env already points at the branch. Set another schemaName in schema.ts, then rerun \`appkit db init\`.`,
    );
  }
  if (ownedOutside.length > 0) {
    throw new Error(
      `Refusing to hand ${where} to you: deleting role "${ownerName}" would also give you what else it owns on this branch: ${ownedOutside.join(", ")}. .env already points at the branch. Reassign or drop them, or take them all with \`databricks postgres delete-role ${role.name} --reassign-owned-to ${input.developer.name}\`, then rerun \`appkit db init\`.`,
    );
  }
  const inOtherDatabases = dependencies.owned.filter((d) => d.database);
  if (inOtherDatabases.length > 0) {
    throw new Error(
      `Refusing to hand ${where} to you: role "${ownerName}" also owns objects in other databases on this branch, which deleting it cannot reassign: ${describe(inOtherDatabases)}. .env already points at the branch. Reassign or drop them in those databases, then rerun \`appkit db init\`.`,
    );
  }
  input.onStep(
    `Handing ${where} to you: deleting this branch's copy of role ${ownerName}, which owns it, with its objects reassigned to you`,
  );
  try {
    await ctx
      .api()
      .deleteRole(role.name, { reassignOwnedTo: input.developer.name });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const { owned, granted } = dependencies;
    const fix =
      owned.length > 0 && granted.length > 0
        ? "Reassign or drop what it owns and revoke its privileges"
        : owned.length > 0
          ? "Reassign or drop what it owns"
          : "Revoke its privileges";
    const details = [
      ...(owned.length > 0
        ? [
            `"${ownerName}" still owns ${describe(owned)}, which block the delete.`,
          ]
        : []),
      ...(granted.length > 0
        ? [`Privileges granted to "${ownerName}": ${describe(granted)}.`]
        : []),
    ];
    throw new Error(
      details.length > 0
        ? `Could not hand ${where} to you: deleting role "${ownerName}" failed (${reason}). ${details.join(" ")} .env already points at the branch. ${fix}, then rerun \`appkit db init\`.`
        : `Could not hand ${where} to you: deleting role "${ownerName}" failed (${reason}). .env already points at the branch; rerun \`appkit db init\` to retry.`,
      { cause: error },
    );
  }
  return ownerName;
}
