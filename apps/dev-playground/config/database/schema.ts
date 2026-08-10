// Annotations a reviewer leaves on a saved dashboard, plus the audit trail the
// plugin keeps for them. Three tables is enough to exercise a two-edge include;
// the DatabasePlugin does not create them, so the app expects them to exist.

import {
  defineSchema,
  fk,
  id,
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

  return { boards, notes, note_events };
});
