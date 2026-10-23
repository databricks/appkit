import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { noteAuthor, signedIn } from "../policies";

const body = z.string().trim().min(1).max(2000);

/** A board's 20 newest notes, each with its audit trail. */
export const listNotes = defineOperation({
  name: "notes.list",
  entity: "notes",
  method: "GET",
  input: z.object({ board_id: z.number().int() }),
  output: z.array(
    z.object({
      id: z.number(),
      author: z.string(),
      body: z.string(),
      created_at: z.string(),
      note_events: z.array(
        z.object({
          id: z.number(),
          action: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
  ),
  authorize: signedIn,
  execute: ({ db, input }) =>
    db.notes
      .where({ board_id: input.board_id })
      .order({ id: "desc" })
      .limit(20)
      .include({ note_events: { order: { id: "asc" }, limit: 10 } })
      .toArray(),
});

/**
 * A note by the caller and its "created" event, in one transaction: if the
 * event cannot be written, the note is not either.
 */
export const createNote = defineOperation({
  name: "notes.create",
  entity: "notes",
  method: "POST",
  input: z.object({ board_id: z.number().int(), body }),
  authorize: signedIn,
  execute: ({ actor, db, input }) =>
    db.transaction(async (tx) => {
      const note = await tx.notes.create({
        board_id: input.board_id,
        body: input.body,
        author: actor.id,
        author_email: actor.email ?? null,
      });
      await tx.note_events.create({ note_id: note.id, action: "created" });
      return note;
    }),
});

/** A new body for the caller's own note, recorded as an "edited" event. */
export const updateNote = defineOperation({
  name: "notes.update",
  entity: "notes",
  method: "PATCH",
  input: z.object({ id: z.number().int(), body }),
  authorize: noteAuthor,
  execute: ({ db, input }) =>
    db.transaction(async (tx) => {
      const note = await tx.notes.update(input.id, { body: input.body });
      if (note) {
        await tx.note_events.create({ note_id: note.id, action: "edited" });
      }
      return note;
    }),
});

/** The caller's own note; its events go with it through the foreign key. */
export const deleteNote = defineOperation({
  name: "notes.delete",
  entity: "notes",
  method: "DELETE",
  authorize: noteAuthor,
  execute: ({ db, input }) => db.notes.delete(input.id),
});
