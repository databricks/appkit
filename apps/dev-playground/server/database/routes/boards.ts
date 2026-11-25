import { randomUUID } from "node:crypto";

import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { signedIn } from "../policies";

/** Every board, oldest first, with how many notes it holds. */
export const listBoards = defineOperation({
  name: "boards.list",
  method: "GET",
  output: z.array(
    z.object({
      id: z.number(),
      slug: z.string(),
      title: z.string(),
      note_count: z.number(),
    }),
  ),
  authorize: signedIn,
  execute: async ({ db }) => {
    const boards = await db.boards.order({ id: "asc" }).limit(50).toArray();
    return Promise.all(
      boards.map(async (board) => ({
        ...board,
        note_count: await db.notes.where({ board_id: board.id }).count(),
      })),
    );
  },
});

/** A new board. The server derives its unique slug from the title. */
export const createBoard = defineOperation({
  name: "boards.create",
  method: "POST",
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  output: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string(),
    created_at: z.string(),
  }),
  authorize: signedIn,
  execute: ({ db, input }) => {
    const base =
      input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 55) || "board";
    // Titles like "A B" and "A-B" share a base, so a random suffix keeps the slug unique.
    return db.boards.create({
      slug: `${base}-${randomUUID().slice(0, 8)}`,
      title: input.title,
    });
  },
});
