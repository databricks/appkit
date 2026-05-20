{{if .plugins.lakebase -}}
// Drizzle Kit configuration for schema migrations.
//
// Commands:
//   npm run db:generate  — Generate SQL migration files from schema (no DB needed)
//   npm run db:push      — Push schema directly to database (dev, requires password auth)
//   npm run db:migrate   — Apply pending migrations via CLI (alternative to programmatic migrate())
//
// Note: db:push requires password auth — enable it in the Lakebase UI
// under Branch Overview → Authentication.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // dbCredentials only needed for db:push and db:studio (not for db:generate)
  ...(process.env.PGHOST
    ? {
        dbCredentials: {
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT || 5432),
          database: process.env.PGDATABASE!,
          user: process.env.PGUSER!,
          password: process.env.PGPASSWORD!,
          ssl: process.env.PGSSLMODE === 'require' ? 'require' : undefined,
        },
      }
    : {}),
});
{{- end}}
