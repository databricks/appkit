import type { PoolClient } from "pg";

export const INSUFFICIENT_PRIVILEGE = "42501";

interface SchemaOwnership {
  readonly schemaName: string;
  readonly owner: string | null;
  readonly currentUser: string;
  readonly canCreate: boolean | null;
}

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
    if (ownership.canCreate === false) {
      return (
        `Schema public belongs to "${ownership.owner}", and the app's role "${ownership.currentUser}" has no CREATE on it. ` +
        `Grant it once with GRANT CREATE ON SCHEMA public TO "${ownership.currentUser}", or drop schemaName from defineSchema() to use the default schema app, which the app creates and owns.`
      );
    }
    return (
      `Role "${ownership.currentUser}" can create in schema public, so an object this migration changes belongs to another role, and no Postgres role can hand it to "${ownership.currentUser}". ` +
      "Drop schemaName from defineSchema() to use the default schema app, which the app creates and owns."
    );
  }
  if (ownership && ownership.owner !== ownership.currentUser) {
    // ALTER ... OWNER TO the app's role fails with "must be able to SET ROLE":
    // nobody holds ADMIN or SET on an Apps service principal role, so only the
    // platform's delete-role --reassign-owned-to can move the objects.
    return (
      `Schema "${ownership.schemaName}" is owned by "${ownership.owner}", but the app connects as "${ownership.currentUser}". ` +
      "If two apps share this database, give each its own schemaName in schema.ts. " +
      "Otherwise the app was recreated with a new service principal, or its database resource was removed and added again, " +
      `and Lakebase handed the objects to "${ownership.owner}". No Postgres role can hand them back to "${ownership.currentUser}"; only Lakebase can move them. ` +
      `If "${ownership.owner}" belonged to a deleted app, or is the role of the person who removed the resource, someone with CAN MANAGE on the Lakebase project moves its objects with ` +
      `\`databricks postgres delete-role <its role> --reassign-owned-to <the role of "${ownership.currentUser}">\` (\`databricks postgres list-roles <branch>\` names both). ` +
      "That moves every object the role owns on the branch and deletes the role, so first check what it owns in each database."
    );
  }
  return (
    "The connecting role lacks a privilege this migration needs: CREATE on the database, or ownership of the app schema and its tables. " +
    "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE. " +
    "If another role owns an object the migration changes, no Postgres role can hand it to the service principal; only Lakebase can move it."
  );
}
