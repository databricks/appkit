{{if .plugins.lakebase -}}
// Drizzle Kit configuration for schema migrations.
// drizzle-kit requires password auth — Lakebase supports it alongside OAuth.
// Enable password auth in the Lakebase UI under Branch Overview → Authentication.
//
// Usage:
//   npm run db:push      — Push schema directly to database (dev)
//   npm run db:generate  — Generate SQL migration files (production)
//   npm run db:migrate   — Apply pending migrations (production)

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.PGHOST!,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    password: process.env.PGPASSWORD!,
    ssl: process.env.PGSSLMODE === 'require' ? 'require' : undefined,
  },
});
{{- end}}
