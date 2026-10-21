// Annotations a reviewer leaves on a saved dashboard, plus the audit trail the
// plugin keeps for them. Three tables is enough to exercise a two-edge include;
// the DatabasePlugin does not create them, so the app expects them to exist.

import {
  defineSchema,
  fk,
  id,
  integer,
  text,
  timestamp,
  varchar,
} from "@databricks/appkit/beta";

export const schema = defineSchema(({ table }) => {
  const boards = table("boards", {
    id: id(),
    slug: varchar(64).notNull().unique(),
    title: text().notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  });

  const notes = table("notes", {
    id: id(),
    board_id: fk(() => boards.id)
      .notNull()
      .onDelete("cascade"),
    author: text().notNull(),
    // Server code needs it to notify the reviewer; no client should see it.
    author_email: text().private(),
    body: text().notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  });

  const note_events = table("note_events", {
    id: id(),
    note_id: fk(() => notes.id)
      .notNull()
      .onDelete("cascade"),
    action: varchar(32).notNull(),
    created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  });

  // Operations example (config/database/routes/orders.ts). Exposed only through
  // operations, never generated CRUD; see orders.sql for the tables and seed.
  const orders = table("orders", {
    id: id(),
    team_id: text().notNull(),
    created_by: text().notNull(),
    status: varchar(16).notNull(),
    total_cents: integer().notNull(),
    approved_by: text(),
  });

  // Example permission data. AppKit has no team or role source; an app owns
  // whatever its policies read.
  const team_members = table("team_members", {
    id: id(),
    user_id: text().notNull(),
    team_id: text().notNull(),
    role: varchar(16).notNull(),
    approval_limit_cents: integer().notNull(),
  });

  return { boards, notes, note_events, orders, team_members };
});
