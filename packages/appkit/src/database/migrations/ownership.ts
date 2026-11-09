// Ownership model: each branch has one owner, the identity its migrations run
// as, and that identity owns the app's objects there. On the deploy branch it
// is the app's service principal, which creates the app schema on first start.
// There is no shared owner role and no SET ROLE: a shared role needs someone
// holding ADMIN OPTION on it to grant it to every new app, which a deployed
// app cannot do for itself.

import type { PoolClient } from "pg";

/** insufficient_privilege: "must be owner of …", "permission denied for …". */
export const INSUFFICIENT_PRIVILEGE = "42501";

/** Who owns the app schema, next to who is connected; owner and canCreate are null when the schema does not exist. */
interface SchemaOwnership {
  readonly schemaName: string;
  readonly owner: string | null;
  readonly currentUser: string;
  /** Whether the connecting role holds CREATE on the schema. */
  readonly canCreate: boolean | null;
}

/** Read the app schema's owner and the connecting role's CREATE on it. pg_catalog needs no privileges. */
export async function schemaOwnership(
  client: Pick<PoolClient, "query">,
  schemaName: string,
): Promise<SchemaOwnership> {
  const { rows } = await client.query<{
    owner: string | null;
    can_create: boolean | null;
    current_user: string;
  }>(
    `select (select pg_catalog.pg_get_userbyid(n.nspowner)
               from pg_catalog.pg_namespace n where n.nspname = $1) as owner,
            (select pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')
               from pg_catalog.pg_namespace n where n.nspname = $1) as can_create,
            current_user::text as current_user`,
    [schemaName],
  );
  return {
    schemaName,
    owner: rows[0]?.owner ?? null,
    currentUser: rows[0]?.current_user ?? "",
    canCreate: rows[0]?.can_create ?? null,
  };
}

/** How to fix a migration that failed for lack of privileges; undefined for any other SQLSTATE. */
export function ownershipHint(
  code: string | undefined,
  ownership?: SchemaOwnership,
): string | undefined {
  if (code !== INSUFFICIENT_PRIVILEGE) return undefined;
  if (ownership && ownership.owner === null) {
    return (
      `Role "${ownership.currentUser}" cannot create schema "${ownership.schemaName}". ` +
      "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE."
    );
  }
  if (
    ownership?.schemaName === "public" &&
    ownership.owner !== ownership.currentUser
  ) {
    // Nobody owns public as an app, so the fault is either CREATE or an object another role owns.
    if (ownership.canCreate === false) {
      return (
        `Schema public belongs to "${ownership.owner}", and the app's role "${ownership.currentUser}" has no CREATE on it. ` +
        `Grant it once with GRANT CREATE ON SCHEMA public TO "${ownership.currentUser}", or drop schemaName from defineSchema() to use the default schema app, which the app creates and owns.`
      );
    }
    return (
      `Role "${ownership.currentUser}" can create in schema public, so an object this migration changes belongs to another role. ` +
      `Have that role transfer it with ALTER TABLE public.<table> OWNER TO "${ownership.currentUser}", or drop schemaName from defineSchema() to use the default schema app, which the app creates and owns.`
    );
  }
  if (ownership && ownership.owner !== ownership.currentUser) {
    return (
      `Schema "${ownership.schemaName}" is owned by "${ownership.owner}", but the app connects as "${ownership.currentUser}". ` +
      "This happens when the app's database resource was removed and added again, or the app was recreated with a new service principal: " +
      `Lakebase hands the objects to another role. Have "${ownership.owner}" transfer the schema and its tables to "${ownership.currentUser}" ` +
      "(ALTER … OWNER TO), or set another schemaName in schema.ts."
    );
  }
  return (
    "The connecting role lacks a privilege this migration needs: CREATE on the database, or ownership of the app schema and its tables. " +
    "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE, " +
    "and if another role created an object the migration changes, have that role transfer it to the app's service principal."
  );
}
