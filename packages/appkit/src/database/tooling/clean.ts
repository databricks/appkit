import type { PoolClient } from "pg";

import { loadDefaultDatabaseSchema } from "../../plugins/database/load-schema";
import { quoteIdentifier } from "../migrations/apply";
import { runInTransaction } from "./branch-sql";
import { type DbContext, NO_ENV_BRANCH, withBranchPool } from "./context";
import { notYourBranch, resolveEnvBranch, writableEnvBranch } from "./guard";
import { type HistoryLock, withHistoryLock } from "./history-lock";
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
 * Objects outside what clean drops that CASCADE removes with it: a view in
 * another schema, a view over that view, a foreign key into an app table, a
 * column of an app type. For public, "outside" also means owned by another
 * role. The closure follows pg_depend the way DROP does: through normal, auto
 * and internal dependencies, where a view's rewrite rule or a view's column
 * stands for the view. Like DROP's own notice, it lists what a normal
 * dependency reached; what went along automatically (an index on a dropped
 * column) is not listed.
 */
const DEPENDENTS_SQL = `
with recursive target as (
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
), gone(classid, objid, objsubid, listed) as (
  select classid, objid, 0, false from dropped
  union
  select
    case when d.classid = 'pg_catalog.pg_rewrite'::regclass
         then 'pg_catalog.pg_class'::regclass else d.classid end,
    coalesce(rule.ev_class, d.objid),
    case when rule.oid is not null or view.oid is not null then 0 else d.objsubid end,
    d.deptype = 'n'
  from gone g
  join pg_catalog.pg_depend d
    on d.refclassid = g.classid and d.refobjid = g.objid
   and (g.objsubid = 0 or d.refobjsubid = g.objsubid)
  left join pg_catalog.pg_rewrite rule
    on d.classid = 'pg_catalog.pg_rewrite'::regclass and rule.oid = d.objid
  left join pg_catalog.pg_class view
    on d.classid = 'pg_catalog.pg_class'::regclass and d.objsubid <> 0
   and view.oid = d.objid and view.relkind in ('v', 'm')
  where d.deptype in ('n', 'a', 'i')
)
select distinct o.label
  from gone g
  cross join lateral (
    select c.relnamespace as namespace, c.relowner as owner,
           pg_catalog.pg_describe_object(g.classid, g.objid, g.objsubid) as label
      from pg_catalog.pg_class c
     where g.classid = 'pg_catalog.pg_class'::regclass and c.oid = g.objid
    union all
    select con.connamespace, coalesce(c.relowner, t.typowner),
           pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_constraint con
      left join pg_catalog.pg_class c on c.oid = con.conrelid
      left join pg_catalog.pg_type t on t.oid = con.contypid
     where g.classid = 'pg_catalog.pg_constraint'::regclass and con.oid = g.objid
    union all
    select p.pronamespace, p.proowner, pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_proc p
     where g.classid = 'pg_catalog.pg_proc'::regclass and p.oid = g.objid
    union all
    select t.typnamespace, t.typowner, pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_type t
     where g.classid = 'pg_catalog.pg_type'::regclass and t.oid = g.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_trigger tg join pg_catalog.pg_class c on c.oid = tg.tgrelid
     where g.classid = 'pg_catalog.pg_trigger'::regclass and tg.oid = g.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_attrdef a join pg_catalog.pg_class c on c.oid = a.adrelid
     where g.classid = 'pg_catalog.pg_attrdef'::regclass and a.oid = g.objid
    union all
    select c.relnamespace, c.relowner, pg_catalog.pg_describe_object(g.classid, g.objid, 0)
      from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid
     where g.classid = 'pg_catalog.pg_policy'::regclass and pol.oid = g.objid
  ) o
  cross join target
  cross join me
 where g.listed
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

/**
 * The relations, types and routines in schema public that other roles own,
 * which clean leaves with their rows; an extension's objects are not listed.
 * Nothing for another schema, which the drop takes whole.
 */
const KEPT_SQL = `
with ns as (
  select oid from pg_catalog.pg_namespace where nspname = 'public'
), me as (
  select oid from pg_catalog.pg_roles where rolname = current_user
), kept(classid, objid) as (
  select 'pg_catalog.pg_class'::regclass, c.oid from pg_catalog.pg_class c, ns, me
   where c.relnamespace = ns.oid and c.relowner <> me.oid
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'pg_catalog.pg_type'::regclass, t.oid from pg_catalog.pg_type t, ns, me
   where t.typnamespace = ns.oid and t.typowner <> me.oid
     and (t.typtype in ('e', 'd')
          or (t.typtype = 'c' and exists (
                select 1 from pg_catalog.pg_class c where c.oid = t.typrelid and c.relkind = 'c')))
  union all
  select 'pg_catalog.pg_proc'::regclass, p.oid from pg_catalog.pg_proc p, ns, me
   where p.pronamespace = ns.oid and p.proowner <> me.oid and p.prokind in ('f', 'p', 'a', 'w')
)
select pg_catalog.pg_describe_object(k.classid, k.objid, 0) as label
  from kept k
 where not exists (
   select 1 from pg_catalog.pg_depend d
    where d.deptype = 'e' and d.classid = k.classid and d.objid = k.objid)
 order by 1`;

export async function readKeptObjects(
  client: Pick<PoolClient, "query">,
  schemaName: string,
): Promise<string[]> {
  if (schemaName !== "public") return [];
  const { rows } = await client.query<{ label: string }>(KEPT_SQL);
  return rows.map((row) => row.label);
}

export interface CleanReport {
  readonly branch: string;
  readonly schemaName: string;
  /** Objects outside the app schema that depend on it, which the drop removes too. */
  readonly dependents: readonly string[];
  /** In schema public, the objects other roles own, which stay with their rows. */
  readonly kept: readonly string[];
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
  return withBranchPool(ctx, async (pool) => {
    const dependents = await readCascadeDependents(pool, target.schemaName);
    // Before the drop, another role's object that depends on yours is still there; it goes.
    const kept = (await readKeptObjects(pool, target.schemaName)).filter(
      (label) => !dependents.includes(label),
    );
    return { ...target, dependents, kept };
  });
}

/**
 * `appkit db clean`: remove every app-schema object, the migration journal
 * included, on your dev or session branch. Refuses any other branch before
 * connecting. One command at a time owns the checkout's history.
 */
export async function runClean(ctx: DbContext): Promise<CleanReport> {
  // Before the lock, which creates config/database.
  requireSchemaFile(ctx.root, "clean");
  return withHistoryLock(ctx.root, "clean", (lock) => cleanHolding(ctx, lock));
}

/** runClean for a caller that already holds the checkout's history lock. */
export async function cleanHolding(
  ctx: DbContext,
  lock: HistoryLock,
): Promise<CleanReport> {
  // Dropping the schema drops the branch's migration journal too.
  lock.assertHeld();
  const target = await cleanTarget(ctx);
  return runInTransaction(ctx, async (client) => {
    const dependents = await readCascadeDependents(client, target.schemaName);
    for (const statement of cleanStatements(target.schemaName)) {
      await client.query(statement);
    }
    const kept = await readKeptObjects(client, target.schemaName);
    return { ...target, dependents, kept };
  });
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
