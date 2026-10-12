import type { PoolClient } from "pg";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { quoteIdentifier } from "../migrations/apply";
import { runInTransaction } from "./branch-sql";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "./context";
import { notYourBranch, resolveEnvBranch, writableEnvBranch } from "./guard";
import { requireSchemaFile } from "./migrate";
import { resourceId } from "./targets";

/**
 * Drop the app schema with everything in it, the migration journal included.
 * Schema public is never dropped: only the relations, types and routines the
 * connected role owns go, and objects an extension installed stay.
 */
export function cleanStatements(schemaName: string): readonly string[] {
  if (schemaName !== "public") {
    return [`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`];
  }
  return [
    `DO $appkit$
DECLARE
  me oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  ns oid := (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public');
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
     WHERE c.relnamespace = ns
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner = me
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
            AND d.deptype IN ('a', 'i', 'e'))
  LOOP
    EXECUTE pg_catalog.format('DROP %s IF EXISTS public.%I CASCADE',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      r.relname);
  END LOOP;
  FOR r IN
    SELECT t.typname FROM pg_catalog.pg_type t
     WHERE t.typnamespace = ns
       AND t.typowner = me
       AND (t.typtype IN ('e', 'd')
            OR (t.typtype = 'c' AND EXISTS (
                  SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.deptype = 'e'
            AND ((d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid)
                 OR (d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = t.typrelid)))
  LOOP
    EXECUTE pg_catalog.format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
  FOR r IN
    SELECT p.proname, p.prokind, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = ns
       AND p.prokind IN ('f', 'p', 'a', 'w')
       AND p.proowner = me
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    -- args is null when an earlier CASCADE already dropped the routine.
    CONTINUE WHEN r.args IS NULL;
    EXECUTE pg_catalog.format('DROP %s IF EXISTS public.%I(%s) CASCADE',
      CASE r.prokind WHEN 'a' THEN 'AGGREGATE' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
      r.proname,
      CASE WHEN r.prokind = 'a' AND r.args = '' THEN '*' ELSE r.args END);
  END LOOP;
END
$appkit$`,
  ];
}

/**
 * Objects outside what clean drops that depend on it, so CASCADE removes them
 * too: a view in another schema, a foreign key into an app table, a column of
 * an app type. For public, "outside" also means owned by another role.
 */
const DEPENDENTS_SQL = `
with target as (
  select oid from pg_catalog.pg_namespace where nspname = $1
), me as (
  select oid from pg_catalog.pg_roles where rolname = current_user
), dropped(classid, objid) as (
  select 'pg_catalog.pg_class'::regclass, c.oid from pg_catalog.pg_class c, target, me
   where c.relnamespace = target.oid and (not $2 or c.relowner = me.oid)
  union all
  select 'pg_catalog.pg_type'::regclass, t.oid from pg_catalog.pg_type t, target, me
   where t.typnamespace = target.oid and (not $2 or t.typowner = me.oid)
  union all
  select 'pg_catalog.pg_proc'::regclass, p.oid from pg_catalog.pg_proc p, target, me
   where p.pronamespace = target.oid and (not $2 or p.proowner = me.oid)
)
select distinct o.label
  from pg_catalog.pg_depend d
  join dropped on d.refclassid = dropped.classid and d.refobjid = dropped.objid
  cross join lateral (
    select c.relnamespace as namespace, c.relowner as owner,
           pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) as label
      from pg_catalog.pg_class c
     where d.classid = 'pg_catalog.pg_class'::regclass and c.oid = d.objid
    union all
    select c.relnamespace, c.relowner,
           pg_catalog.pg_describe_object('pg_catalog.pg_class'::regclass, c.oid, 0)
      from pg_catalog.pg_rewrite r join pg_catalog.pg_class c on c.oid = r.ev_class
     where d.classid = 'pg_catalog.pg_rewrite'::regclass and r.oid = d.objid
    union all
    select con.connamespace, coalesce(c.relowner, t.typowner),
           pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_constraint con
      left join pg_catalog.pg_class c on c.oid = con.conrelid
      left join pg_catalog.pg_type t on t.oid = con.contypid
     where d.classid = 'pg_catalog.pg_constraint'::regclass and con.oid = d.objid
    union all
    select p.pronamespace, p.proowner, pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_proc p
     where d.classid = 'pg_catalog.pg_proc'::regclass and p.oid = d.objid
    union all
    select t.typnamespace, t.typowner, pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_type t
     where d.classid = 'pg_catalog.pg_type'::regclass and t.oid = d.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_trigger tg join pg_catalog.pg_class c on c.oid = tg.tgrelid
     where d.classid = 'pg_catalog.pg_trigger'::regclass and tg.oid = d.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_attrdef a join pg_catalog.pg_class c on c.oid = a.adrelid
     where d.classid = 'pg_catalog.pg_attrdef'::regclass and a.oid = d.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(d.classid, d.objid, 0)
      from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid
     where d.classid = 'pg_catalog.pg_policy'::regclass and pol.oid = d.objid
  ) o
  cross join target
  cross join me
 where d.deptype = 'n'
   and (o.namespace <> target.oid or ($2 and o.owner <> me.oid))
 order by 1`;

export async function readCascadeDependents(
  client: Pick<PoolClient, "query">,
  schemaName: string,
): Promise<string[]> {
  const { rows } = await client.query<{ label: string }>(DEPENDENTS_SQL, [
    schemaName,
    schemaName === "public",
  ]);
  return rows.map((row) => row.label);
}

export interface CleanReport {
  readonly branch: string;
  readonly schemaName: string;
  /** Objects outside the app schema that depend on it, which the drop removes too. */
  readonly dependents: readonly string[];
}

async function cleanTarget(ctx: DbContext) {
  requireSchemaFile(ctx.root, "clean");
  const branch = await writableEnvBranch(ctx, "clean");
  const schema = await loadDefaultDatabaseSchema(ctx.root, {
    showImportError: true,
  });
  return { branch: branch.name, schemaName: schema.$schemaName };
}

/** What `appkit db clean` would drop, read without changing anything. */
export async function previewClean(ctx: DbContext): Promise<CleanReport> {
  const target = await cleanTarget(ctx);
  const dependents = await withBranchPool(ctx, (pool) =>
    readCascadeDependents(pool, target.schemaName),
  );
  return { ...target, dependents };
}

/**
 * `appkit db clean`: remove every app-schema object, the migration journal
 * included, on your dev or session branch. Refuses any other branch before
 * connecting.
 */
export async function runClean(ctx: DbContext): Promise<CleanReport> {
  const target = await cleanTarget(ctx);
  const dependents = await runInTransaction(ctx, async (client) => {
    const found = await readCascadeDependents(client, target.schemaName);
    for (const statement of cleanStatements(target.schemaName)) {
      await client.query(statement);
    }
    return found;
  });
  return { ...target, dependents };
}

/**
 * `appkit db clean --delete-branch`: delete this checkout's session branch.
 * The dev branch is kept, so the next `appkit db init` finds it.
 */
export async function deleteSessionBranch(
  ctx: DbContext,
): Promise<{ readonly branch: string }> {
  const env = await resolveEnvBranch(ctx);
  if (!env) throw new Error(`Did not delete the branch: ${NO_ENV_BRANCH}.`);
  const { name } = env.branch;
  if (env.kind === "dev") {
    throw new Error(
      `Refusing to delete ${resourceId(name)}: --delete-branch deletes session branches only, and your dev branch stays for the next \`appkit db init\`. Delete it with \`databricks postgres delete-branch ${name}\`.`,
    );
  }
  if (env.kind !== "session") {
    throw new Error(`Refusing to delete the branch: ${notYourBranch(env)}.`);
  }
  await ctx.api().deleteBranch(name);
  return { branch: name };
}
