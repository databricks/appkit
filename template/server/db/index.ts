{{if .plugins.lakebase -}}
// Database initialization and schema setup.
//
// Schema setup uses raw SQL for the initial CREATE SCHEMA/TABLE (needed for first deploy).
// For subsequent schema changes, use drizzle-kit:
//   npm run db:push      (dev — push schema directly)
//   npm run db:generate  (production — generate migration files)
//   npm run db:migrate   (production — apply migrations)

import type { LakebasePool } from '@databricks/appkit';
import * as schema from './schema';

export { schema };

export type Database = Awaited<ReturnType<typeof initDb>>;

const TABLE_EXISTS_SQL = `
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'app' AND table_name = 'todos'
`;

const SETUP_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS app`;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app.todos (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

export async function ensureSchema(pool: LakebasePool): Promise<void> {
  const { rows } = await pool.query(TABLE_EXISTS_SQL);
  if (rows.length > 0) {
    console.log('[lakebase] Table app.todos already exists, skipping setup');
    return;
  }
  await pool.query(SETUP_SCHEMA_SQL);
  await pool.query(CREATE_TABLE_SQL);
  console.log('[lakebase] Created schema and table app.todos');
}

export async function initDb(appkit: { lakebase: { drizzle: (schema: typeof import('./schema')) => Promise<any> } }) {
  return appkit.lakebase.drizzle(schema);
}
{{- end}}
