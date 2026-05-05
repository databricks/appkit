{{if .plugins.lakebase -}}
import { z } from 'zod';
import type { Application, Request } from 'express';

interface LakebaseApi {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AppKitWithLakebase {
  lakebase: LakebaseApi & {
    asUser(req: Request): LakebaseApi;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const TABLE_EXISTS_SQL = `
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'app' AND table_name = 'todos'
`;

const SETUP_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS app`;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app.todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT false,
    created_by VARCHAR(255) DEFAULT current_user,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const GRANT_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA app TO PUBLIC;
  GRANT ALL ON ALL TABLES IN SCHEMA app TO PUBLIC;
`;

const CreateTodoBody = z.object({ title: z.string().min(1) });

export async function setupSampleLakebaseRoutes(appkit: AppKitWithLakebase) {
  try {
    const { rows } = await appkit.lakebase.query(TABLE_EXISTS_SQL);
    if (rows.length > 0) {
      console.log('[lakebase] Table app.todos already exists, skipping setup');
    } else {
      await appkit.lakebase.query(SETUP_SCHEMA_SQL);
      await appkit.lakebase.query(CREATE_TABLE_SQL);
      await appkit.lakebase.query(GRANT_ACCESS_SQL);
      console.log('[lakebase] Created schema and table app.todos');
    }
  } catch (err) {
    console.warn('[lakebase] Database setup failed:', (err as Error).message);
    console.warn('[lakebase] Routes will be registered but may return errors');
    console.warn('[lakebase] See https://databricks.github.io/appkit/docs/plugins/lakebase#database-permissions for troubleshooting');
  }

  appkit.server.extend((app) => {
    app.get('/api/lakebase/todos', async (_req, res) => {
      try {
        const result = await appkit.lakebase.query(
          'SELECT id, title, completed, created_by, created_at FROM app.todos ORDER BY created_at DESC',
        );
        res.json(result.rows);
      } catch (err) {
        console.error('Failed to list todos:', err);
        res.status(500).json({ error: 'Failed to list todos' });
      }
    });

    // Uses asUser(req) so current_user in PostgreSQL reflects the user's identity.
    // The created_by column defaults to current_user, recording who created the todo.
    app.post('/api/lakebase/todos', async (req, res) => {
      try {
        const parsed = CreateTodoBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'title is required' });
          return;
        }
        const result = await appkit.lakebase.asUser(req).query(
          'INSERT INTO app.todos (title) VALUES ($1) RETURNING id, title, completed, created_by, created_at',
          [parsed.data.title.trim()],
        );
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('Failed to create todo:', err);
        res.status(500).json({ error: 'Failed to create todo' });
      }
    });

    app.patch('/api/lakebase/todos/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const result = await appkit.lakebase.query(
          'UPDATE app.todos SET completed = NOT completed WHERE id = $1 RETURNING id, title, completed, created_by, created_at',
          [id],
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('Failed to update todo:', err);
        res.status(500).json({ error: 'Failed to update todo' });
      }
    });

    app.delete('/api/lakebase/todos/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const result = await appkit.lakebase.query(
          'DELETE FROM app.todos WHERE id = $1 RETURNING id',
          [id],
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        console.error('Failed to delete todo:', err);
        res.status(500).json({ error: 'Failed to delete todo' });
      }
    });
  });
}
{{- end}}
