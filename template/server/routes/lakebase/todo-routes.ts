{{if .plugins.lakebase -}}
// Todo routes using Drizzle ORM for type-safe database queries.
// For per-user connections (OBO) with Row-Level Security, see:
// https://www.databricks.com/devhub/docs/appkit/v0/plugins/lakebase#on-behalf-of-obo--per-user-connections

import { eq, desc, not } from 'drizzle-orm';
import { z } from 'zod';
import type { Application } from 'express';
import type { Database } from '../../db';
import { todos } from '../../db/schema';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const CreateTodoBody = z.object({ title: z.string().min(1) });

export function setupTodoRoutes(appkit: AppKitWithServer, db: Database) {
  appkit.server.extend((app) => {
    app.get('/api/lakebase/todos', async (_req, res) => {
      try {
        const result = await db
          .select()
          .from(todos)
          .orderBy(desc(todos.createdAt));
        res.json(result);
      } catch (err) {
        console.error('Failed to list todos:', err);
        res.status(500).json({ error: 'Failed to list todos' });
      }
    });

    app.post('/api/lakebase/todos', async (req, res) => {
      try {
        const parsed = CreateTodoBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'title is required' });
          return;
        }
        const [created] = await db
          .insert(todos)
          .values({ title: parsed.data.title.trim() })
          .returning();
        res.status(201).json(created);
      } catch (err) {
        console.error('Failed to create todo:', err);
        res.status(500).json({ error: 'Failed to create todo' });
      }
    });

    app.patch('/api/lakebase/todos/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: 'Invalid id' });
          return;
        }
        const [updated] = await db
          .update(todos)
          .set({ completed: not(todos.completed) })
          .where(eq(todos.id, id))
          .returning();
        if (!updated) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        res.json(updated);
      } catch (err) {
        console.error('Failed to update todo:', err);
        res.status(500).json({ error: 'Failed to update todo' });
      }
    });

    app.delete('/api/lakebase/todos/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: 'Invalid id' });
          return;
        }
        const [deleted] = await db
          .delete(todos)
          .where(eq(todos.id, id))
          .returning({ id: todos.id });
        if (!deleted) {
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
