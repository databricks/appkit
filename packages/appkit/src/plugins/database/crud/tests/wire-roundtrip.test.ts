import { encodeDatabaseListQuery, encodeDatabaseRecordQuery } from "shared";
import { describe, expect, it } from "vitest";

import { DEFAULT_LIMIT } from "../../../../database/contract";
import {
  bigint,
  boolean,
  defineSchema,
  fk,
  id,
  integer,
  text,
  timestamp,
} from "../../../../database/schema-builder";
import { type CrudTable, compileCrudTables } from "../contract";
import { decodeDetailQuery, decodeListQuery } from "../query";

// The browser client encodes with the shared codec; these are the decoders its
// requests actually meet, so the two sides are proven against each other here.
const schema = defineSchema((builder) => {
  const boards = builder.table("boards", {
    id: id(),
    title: text().notNull(),
    archived: boolean().notNull(),
  });
  const notes = builder.table("notes", {
    id: id(),
    board_id: fk(() => boards.id).notNull(),
    body: text().notNull(),
    rank: integer(),
    views: bigint(),
    created_at: timestamp(),
  });
  const note_events = builder.table("note_events", {
    id: id(),
    note_id: fk(() => notes.id).notNull(),
    action: text().notNull(),
  });
  return { boards, notes, note_events };
});

const tables = compileCrudTables(schema.$tables);
const boards = tables.get("boards") as CrudTable;
const notes = tables.get("notes") as CrudTable;

describe("shared encoder against decodeListQuery", () => {
  it("round-trips every list parameter", () => {
    const decoded = decodeListQuery(
      notes,
      encodeDatabaseListQuery({
        where: {
          board_id: 7,
          body: { ilike: "%ship it%" },
          or: [{ rank: { gte: 1, lt: 5 } }, { id: { in: [1, 2, 3] } }],
          and: [{ created_at: { is: null } }],
        },
        order: { created_at: "desc", body: "asc" },
        select: ["id", "body"],
        include: { boards: { select: ["title"] } },
        limit: 20,
        offset: 40,
      }),
    );

    expect(decoded).toEqual({
      where: {
        board_id: 7,
        body: { ilike: "%ship it%" },
        or: [{ rank: { gte: 1, lt: 5 } }, { id: { in: [1, 2, 3] } }],
        and: [{ created_at: { is: null } }],
      },
      order: { created_at: "desc", body: "asc" },
      select: ["id", "body"],
      include: { boards: { select: ["title"] } },
      limit: 20,
      offset: 40,
    });
    // Sort priority is the order of the keys, so it has to survive the trip.
    expect(Object.keys(decoded.order ?? {})).toEqual(["created_at", "body"]);
  });

  it("leaves omitted parameters to the server defaults", () => {
    expect(decodeListQuery(notes, encodeDatabaseListQuery({}))).toEqual({
      where: undefined,
      order: undefined,
      select: undefined,
      include: undefined,
      limit: DEFAULT_LIMIT,
      offset: 0,
    });
    expect(
      decodeListQuery(
        boards,
        encodeDatabaseListQuery({ include: { notes: true }, limit: undefined }),
      ),
    ).toMatchObject({ include: { notes: { limit: DEFAULT_LIMIT } } });
  });

  it("carries reserved and non-ASCII characters through unchanged", () => {
    const text = "a+b & c=d %25 # ? / é 🚀";
    expect(
      decodeListQuery(
        notes,
        encodeDatabaseListQuery({ where: { body: { eq: text } } }),
      ).where,
    ).toEqual({ body: { eq: text } });
  });

  it("decodes a bigint operand from its decimal string", () => {
    expect(
      decodeListQuery(
        notes,
        encodeDatabaseListQuery({
          where: {
            views: { gt: "9007199254740993" },
            or: [{ views: 9007199254740993n }],
          },
        }),
      ).where,
    ).toEqual({
      views: { gt: 9007199254740993n },
      or: [{ views: 9007199254740993n }],
    });
  });

  it("round-trips a two-edge include with a to-many limit", () => {
    expect(
      decodeListQuery(
        boards,
        encodeDatabaseListQuery({
          include: {
            notes: {
              limit: 5,
              order: { created_at: "desc" },
              where: { rank: { gt: 0 } },
              include: { note_events: { limit: 3 } },
            },
          },
          limit: 10,
        }),
      ).include,
    ).toEqual({
      notes: {
        limit: 5,
        order: { created_at: "desc" },
        where: { rank: { gt: 0 } },
        include: { note_events: { limit: 3 } },
      },
    });
  });
});

describe("shared encoder against decodeDetailQuery", () => {
  it("round-trips projection and includes", () => {
    expect(
      decodeDetailQuery(
        boards,
        encodeDatabaseRecordQuery({
          select: ["id", "title"],
          include: {
            notes: { limit: 20, include: { note_events: { limit: 5 } } },
          },
        }),
      ),
    ).toEqual({
      select: ["id", "title"],
      include: {
        notes: { limit: 20, include: { note_events: { limit: 5 } } },
      },
    });
    expect(decodeDetailQuery(boards, encodeDatabaseRecordQuery({}))).toEqual({
      select: undefined,
      include: undefined,
    });
  });
});
