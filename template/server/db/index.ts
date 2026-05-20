{{if .plugins.lakebase -}}
// Database initialization and Drizzle migrations.
//
// Migrations are generated from the schema in server/db/schema.ts:
//   npm run db:generate  — generate migration SQL files
//   npm run db:push      — push schema directly (dev, requires password auth)
//
// At startup, runMigrations() applies any unapplied migrations automatically.

import * as schema from './schema';

export { schema };

export type Database = Awaited<ReturnType<typeof initDb>>;

export async function initDb(appkit: { lakebase: { drizzle: (schema: typeof import('./schema')) => Promise<any> } }) {
  return appkit.lakebase.drizzle(schema);
}

export async function runMigrations(db: Database) {
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(db, { migrationsFolder: './drizzle' });
}
{{- end}}
