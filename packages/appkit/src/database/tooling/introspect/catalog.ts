import { MIGRATIONS_TABLE } from "../../migrations/paths";
import type { ReferentialAction } from "../../schema-builder/types";

export type CatalogQuery = <T>(
  text: string,
  values: readonly unknown[],
) => Promise<T[]>;

export interface IntrospectedEnum {
  readonly name: string;
  readonly schema: string;
  readonly values: readonly string[];
}

export interface IntrospectedSequence {
  readonly start: string;
  readonly increment: string;
  readonly min: string;
  readonly max: string;
  readonly cache: string;
  readonly cycle: boolean;
}

export interface IntrospectedColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  /** attidentity: "" none, "a" always, "d" by default. */
  readonly identity: "" | "a" | "d";
  readonly generated: boolean;
  readonly defaultExpr: string | null;
  readonly enum?: IntrospectedEnum;
  readonly sequence?: IntrospectedSequence;
}

export interface IntrospectedForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly schema: string;
  readonly table: string;
  readonly refColumns: readonly string[];
  readonly onDelete: ReferentialAction;
  readonly onUpdate: ReferentialAction;
  readonly deferrable: boolean;
  readonly matchFull: boolean;
}

export interface IntrospectedUnique {
  readonly name: string;
  readonly columns: readonly string[];
  readonly deferrable: boolean;
}

export interface IntrospectedTable {
  readonly name: string;
  readonly partitioned: boolean;
  readonly columns: readonly IntrospectedColumn[];
  readonly primaryKey: readonly string[];
  readonly unique: readonly IntrospectedUnique[];
  readonly foreignKeys: readonly IntrospectedForeignKey[];
  readonly checks: readonly string[];
  readonly indexes: readonly string[];
}

const ACTIONS: Record<string, ReferentialAction> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

export interface ColumnRow {
  table_name: string;
  name: string;
  type: string;
  not_null: boolean;
  identity: string;
  generated: string;
  default_expr: string | null;
  type_kind: string;
  type_schema: string;
  type_name: string;
  enum_values: string[] | null;
  sequence: IntrospectedSequence | null;
}

export interface TableRow {
  name: string;
  partitioned: boolean;
}

export interface ConstraintRow {
  table_name: string;
  name: string;
  kind: "p" | "u" | "f" | "c" | "x";
  columns: string[];
  ref_schema: string | null;
  ref_table: string | null;
  ref_columns: string[] | null;
  on_delete: string;
  on_update: string;
  deferrable?: boolean;
  /** confmatchtype: "f" full, "s" simple. */
  match_type?: string;
}

export interface IndexRow {
  table_name: string;
  name: string;
}

// pg_catalog, never information_schema: it hides objects the role cannot access.
// Ordinary and partitioned tables only; partitions belong to their parent.
export const TABLES_SQL = `
select c.relname::text as name, c.relkind = 'p' as partitioned
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition
   and c.relname <> $2
 order by c.relname`;

export const COLUMNS_SQL = `
select c.relname::text as table_name, a.attname::text as name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as not_null, a.attidentity::text as identity,
       a.attgenerated::text as generated,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
       t.typtype::text as type_kind, tn.nspname::text as type_schema,
       t.typname::text as type_name,
       case when t.typtype = 'e' then array(
         select e.enumlabel::text from pg_catalog.pg_enum e
          where e.enumtypid = t.oid order by e.enumsortorder)
       end as enum_values,
       seq.options as sequence
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_type t on t.oid = a.atttypid
  join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
  left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  -- The sequence a serial (deptype a) or identity (deptype i) column owns; bounds as text, since bigint exceeds JSON numbers.
  left join lateral (
    select jsonb_build_object(
             'start', s.seqstart::text, 'increment', s.seqincrement::text,
             'min', s.seqmin::text, 'max', s.seqmax::text,
             'cache', s.seqcache::text, 'cycle', s.seqcycle) as options
      from pg_catalog.pg_depend sd
      join pg_catalog.pg_sequence s on s.seqrelid = sd.objid
     where sd.classid = 'pg_catalog.pg_class'::regclass
       and sd.refclassid = 'pg_catalog.pg_class'::regclass
       and sd.refobjid = a.attrelid and sd.refobjsubid = a.attnum
       and sd.deptype in ('a', 'i')
     limit 1) seq on true
 where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition
   and c.relname <> $2 and a.attnum > 0 and not a.attisdropped
 order by c.relname, a.attnum`;

export const CONSTRAINTS_SQL = `
select c.relname::text as table_name, k.conname::text as name, k.contype::text as kind,
       array(select a.attname::text
               from unnest(k.conkey) with ordinality as u(attnum, ord)
               join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
              order by u.ord) as columns,
       rn.nspname::text as ref_schema, rc.relname::text as ref_table,
       array(select a.attname::text
               from unnest(k.confkey) with ordinality as u(attnum, ord)
               join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum
              order by u.ord) as ref_columns,
       k.confdeltype::text as on_delete, k.confupdtype::text as on_update,
       k.condeferrable as deferrable, k.confmatchtype::text as match_type
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join pg_catalog.pg_class rc on rc.oid = k.confrelid
  left join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
 where n.nspname = $1 and k.contype in ('p', 'u', 'f', 'c', 'x') and c.relname <> $2
   -- A foreign key to a partitioned table has one copy per partition; keep the original.
   and k.conparentid = 0
 order by c.relname, k.conname`;

export const INDEXES_SQL = `
select c.relname::text as table_name, i.relname::text as name
  from pg_catalog.pg_index x
  join pg_catalog.pg_class c on c.oid = x.indrelid
  join pg_catalog.pg_class i on i.oid = x.indexrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname <> $2
   and not exists (
     select 1 from pg_catalog.pg_constraint k
      where k.conrelid = x.indrelid and k.conindid = x.indexrelid
        and k.contype in ('p', 'u', 'x'))
 order by c.relname, i.relname`;

export const UNREAD_SQL = `
with ns as (select oid from pg_catalog.pg_namespace where nspname = $1),
objects (label, classid, objid) as (
  select case c.relkind when 'v' then 'view ' when 'm' then 'materialized view '
                        when 'f' then 'foreign table ' else 'sequence ' end || c.relname,
         'pg_catalog.pg_class'::regclass, c.oid
    from pg_catalog.pg_class c
   where c.relnamespace = (select oid from ns) and c.relkind in ('v', 'm', 'f', 'S')
     -- serial and identity sequences belong to their column
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid
          and d.refclassid = 'pg_catalog.pg_class'::regclass and d.deptype in ('a', 'i'))
  union all
  select 'trigger ' || t.tgname || ' on ' || c.relname, 'pg_catalog.pg_trigger'::regclass, t.oid
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
   where c.relnamespace = (select oid from ns) and not t.tgisinternal
  union all
  select 'policy ' || p.polname || ' on ' || c.relname, 'pg_catalog.pg_policy'::regclass, p.oid
    from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relnamespace = (select oid from ns)
  union all
  select 'row-level security on ' || c.relname, 'pg_catalog.pg_class'::regclass, c.oid
    from pg_catalog.pg_class c
   where c.relnamespace = (select oid from ns) and c.relrowsecurity
  union all
  select 'inheritance of ' || c.relname || ' from ' || p.relname, 'pg_catalog.pg_class'::regclass, c.oid
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    join pg_catalog.pg_class p on p.oid = i.inhparent
   where c.relnamespace = (select oid from ns) and not c.relispartition
  union all
  select case p.prokind when 'p' then 'procedure ' when 'a' then 'aggregate ' else 'function ' end
         || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
         'pg_catalog.pg_proc'::regclass, p.oid
    from pg_catalog.pg_proc p
   where p.pronamespace = (select oid from ns)
  union all
  select case t.typtype when 'd' then 'domain ' else 'type ' end || t.typname,
         'pg_catalog.pg_type'::regclass, t.oid
    from pg_catalog.pg_type t
   where t.typnamespace = (select oid from ns)
     and (t.typtype in ('d', 'r')
          or (t.typtype = 'c' and exists (
                select 1 from pg_catalog.pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
          or (t.typtype = 'e' and not exists (
                select 1 from pg_catalog.pg_attribute a
                  join pg_catalog.pg_class c on c.oid = a.attrelid
                 where a.atttypid = t.oid and c.relkind in ('r', 'p') and not a.attisdropped)))
)
select o.label from objects o
 where not exists (
   select 1 from pg_catalog.pg_depend d
    where d.classid = o.classid and d.objid = o.objid and d.deptype = 'e')
 order by o.label`;

function toColumn(row: ColumnRow): IntrospectedColumn {
  const identity =
    row.identity === "a" || row.identity === "d" ? row.identity : "";
  return {
    name: row.name,
    type: row.type,
    notNull: row.not_null,
    identity,
    generated: row.generated !== "",
    defaultExpr: row.default_expr,
    ...(row.type_kind === "e"
      ? {
          enum: {
            name: row.type_name,
            schema: row.type_schema,
            values: row.enum_values ?? [],
          },
        }
      : {}),
    ...(row.sequence ? { sequence: row.sequence } : {}),
  };
}

export function buildTables(
  tables: readonly TableRow[],
  columns: readonly ColumnRow[],
  constraints: readonly ConstraintRow[],
  indexes: readonly IndexRow[] = [],
): IntrospectedTable[] {
  return tables.map(({ name, partitioned }) => {
    const own = constraints.filter((row) => row.table_name === name);
    return {
      name,
      partitioned,
      columns: columns.filter((row) => row.table_name === name).map(toColumn),
      primaryKey: own.find((row) => row.kind === "p")?.columns ?? [],
      unique: own
        .filter((row) => row.kind === "u")
        .map((row) => ({
          name: row.name,
          columns: row.columns,
          deferrable: row.deferrable === true,
        })),
      foreignKeys: own
        .filter((row) => row.kind === "f" && row.ref_table)
        .map((row) => ({
          name: row.name,
          columns: row.columns,
          schema: row.ref_schema ?? "",
          table: row.ref_table ?? "",
          refColumns: row.ref_columns ?? [],
          onDelete: ACTIONS[row.on_delete] ?? "no action",
          onUpdate: ACTIONS[row.on_update] ?? "no action",
          deferrable: row.deferrable === true,
          matchFull: row.match_type === "f",
        })),
      checks: own
        .filter((row) => row.kind === "c" || row.kind === "x")
        .map((row) => row.name),
      indexes: indexes
        .filter((row) => row.table_name === name)
        .map((row) => row.name),
    };
  });
}

export async function readCatalog(
  query: CatalogQuery,
  schemaName: string,
): Promise<IntrospectedTable[]> {
  const params = [schemaName, MIGRATIONS_TABLE];
  const tables = await query<TableRow>(TABLES_SQL, params);
  const columns = await query<ColumnRow>(COLUMNS_SQL, params);
  const constraints = await query<ConstraintRow>(CONSTRAINTS_SQL, params);
  const indexes = await query<IndexRow>(INDEXES_SQL, params);
  return buildTables(tables, columns, constraints, indexes);
}

export async function readUnreadObjects(
  query: CatalogQuery,
  schemaName: string,
): Promise<string[]> {
  const rows = await query<{ label: string }>(UNREAD_SQL, [schemaName]);
  return rows.map((row) => row.label);
}
