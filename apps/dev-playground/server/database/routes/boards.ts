import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";

import { signedIn } from "../policies";

/** Every board, oldest first, with how many notes it holds. */
export const listBoards = defineOperation({
  name: "boards.list",
  entity: "boards",
  method: "GET",
  input: z.object({}),
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
  entity: "boards",
  method: "POST",
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  authorize: signedIn,
  execute: ({ db, input }) =>
    db.boards.create({
      slug:
        input.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64) || "board",
      title: input.title,
    }),
});
