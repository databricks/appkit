// Ownership model: each branch has one owner, the identity its migrations run
// as, and that identity owns the app's objects there:
// - deploy branch: the app's service principal, which creates the app schema
//   on first start;
// - dev / session fork: the developer, once `appkit db init` hands over the
//   objects the fork copied from its parent (Lakebase role API, reassign_owned_to).
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
    "and if another role created the schema, use another schemaName in schema.ts or have that role transfer the schema and its objects. " +
    "On your dev or session branch it is you: `appkit db init` hands you the objects the branch copied from its parent."
  );
}

/** A Postgres identifier in double quotes, with embedded quotes doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** User schemas: everything except pg_* (pg_catalog, pg_toast, …) and information_schema. */
const USER_SCHEMAS = `n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`;

/**
 * Postgres roles, other than current_user, that own a schema, relation, type or
 * function in this database. A fork copies its parent's objects with their
 * owners; `appkit db init` hands each of these roles' objects to the developer
 * (role API delete with reassign_owned_to). Roles the role API does not manage
 * (pg_database_owner, databricks_control_plane, …) are filtered out by the caller.
 */
export const FOREIGN_OWNERS_SQL = `select distinct pg_catalog.pg_get_userbyid(o.owner)::text as owner
  from (
    select n.nspowner as owner from pg_catalog.pg_namespace n where ${USER_SCHEMAS}
    union all
    select c.relowner from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS}
    union all
    select t.typowner from pg_catalog.pg_type t
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace where ${USER_SCHEMAS}
    union all
    select p.proowner from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMAS}
  ) o
 where o.owner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
 order by 1`;

/**
 * Remove every object in the app schema, including the migration journal. Runs
 * as the branch's owner, in one transaction.
 * - A non-public schema is dropped as a unit; the migrator recreates it.
 * - `public` belongs to pg_database_owner and cannot be dropped, so each
 *   function, procedure, relation and standalone type in it that current_user
 *   owns is dropped, routines first. Sequences owned by a column (identity,
 *   serial) go with their table, and a table's row type goes with the table.
 *   Objects that belong to an extension are left to it.
 */
export function cleanStatements(schemaName: string): readonly string[] {
  if (schemaName !== "public") {
    return [`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`];
  }
  return [
    `DO $appkit$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    -- args is null when an earlier CASCADE already dropped the routine.
    CONTINUE WHEN r.args IS NULL;
    EXECUTE pg_catalog.format('DROP ROUTINE IF EXISTS public.%I(%s) CASCADE', r.proname, r.args);
  END LOOP;
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))
  LOOP
    EXECUTE pg_catalog.format('DROP %s IF EXISTS public.%I CASCADE',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.relname);
  END LOOP;
  FOR r IN
    SELECT t.typname FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND (t.typtype IN ('e', 'd')
            OR (t.typtype = 'c' AND EXISTS (
                  SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
  LOOP
    EXECUTE pg_catalog.format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
END
$appkit$`,
  ];
}
