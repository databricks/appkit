{{if .plugins.lakebase -}}
import { boolean, pgSchema, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

export const todos = appSchema.table('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
{{- end}}
