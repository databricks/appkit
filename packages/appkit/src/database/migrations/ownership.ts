// Ownership model: each branch has one owner, the identity its migrations run
// as, and that identity owns the app's objects there. On the deploy branch it
// is the app's service principal, which creates the app schema on first start.
// There is no shared owner role and no SET ROLE. A shared owner role is not
// possible: Lakebase rejects `GRANT … TO databricks_superuser`.

/** insufficient_privilege: "must be owner of …", "permission denied for …". */
const INSUFFICIENT_PRIVILEGE = "42501";

/** How to fix a migration that failed for lack of privileges; undefined for any other SQLSTATE. */
export function ownershipHint(code: string | undefined): string | undefined {
  if (code !== INSUFFICIENT_PRIVILEGE) return undefined;
  return (
    "The connecting role lacks a privilege this migration needs: CREATE on the database, or ownership of the app schema and its tables. " +
    "On the deploy branch that role is the app's service principal: bind the database to the app with CAN_CONNECT_AND_CREATE, " +
    "and if another role created the schema, use another schemaName in schema.ts or have that role transfer the schema and its objects."
  );
}
