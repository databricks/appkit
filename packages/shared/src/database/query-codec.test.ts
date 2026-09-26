import { describe, expect, it } from "vitest";

import { databaseErrorCategoryForStatus } from "./errors";
import {
  encodeDatabaseListQuery,
  encodeDatabaseRecordQuery,
} from "./query-codec";

function decoded(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query));
}

describe("encodeDatabaseListQuery", () => {
  it("encodes nothing for an empty or all-undefined request", () => {
    expect(encodeDatabaseListQuery({})).toBe("");
    expect(
      encodeDatabaseListQuery({
        where: undefined,
        order: undefined,
        select: undefined,
        include: undefined,
        limit: undefined,
        offset: undefined,
      }),
    ).toBe("");
  });

  it("sends one JSON value per structured parameter and decimal pagination", () => {
    const query = encodeDatabaseListQuery({
      where: { board_id: 7, or: [{ author: { ilike: "a%" } }] },
      order: { created_at: "desc", id: "asc" },
      select: ["id", "body"],
      include: { notes: { limit: 5 } },
      limit: 20,
      offset: 40,
    });

    expect(decoded(query)).toEqual({
      where: '{"board_id":7,"or":[{"author":{"ilike":"a%"}}]}',
      order: '{"created_at":"desc","id":"asc"}',
      select: '["id","body"]',
      include: '{"notes":{"limit":5}}',
      limit: "20",
      offset: "40",
    });
  });

  it("is deterministic regardless of the caller's parameter order", () => {
    const forward = encodeDatabaseListQuery({
      where: { id: 1 },
      limit: 5,
      select: ["id"],
    });
    const backward = encodeDatabaseListQuery({
      select: ["id"],
      limit: 5,
      where: { id: 1 },
    });
    expect(forward).toBe(backward);
    expect([...new URLSearchParams(forward).keys()]).toEqual([
      "where",
      "select",
      "limit",
    ]);
  });

  it("keeps order keys in the caller's sequence, since it is sort priority", () => {
    const query = encodeDatabaseListQuery({
      order: { title: "asc", created_at: "desc" },
    });
    expect(decoded(query).order).toBe('{"title":"asc","created_at":"desc"}');
  });

  it("omits undefined nested values and escapes reserved characters", () => {
    const query = encodeDatabaseListQuery({
      where: { body: { like: "a+b&c=%" }, author: undefined },
    });
    expect(query).not.toContain("&c=");
    expect(decoded(query).where).toBe('{"body":{"like":"a+b&c=%"}}');
  });

  it("encodes a bigint operand as its decimal string", () => {
    const query = encodeDatabaseListQuery({
      where: { total: { gt: 9007199254740993n } },
    });
    expect(decoded(query).where).toBe('{"total":{"gt":"9007199254740993"}}');
  });

  it("ignores parameters the list route does not accept", () => {
    const query = encodeDatabaseListQuery({
      limit: 1,
      ...({ includeTotal: true } as object),
    });
    expect(query).toBe("limit=1");
  });
});

describe("encodeDatabaseRecordQuery", () => {
  it("encodes projection and includes only", () => {
    expect(encodeDatabaseRecordQuery({})).toBe("");
    const query = encodeDatabaseRecordQuery({
      include: { notes: { include: { note_events: true } } },
      select: ["id"],
    });
    expect(decoded(query)).toEqual({
      select: '["id"]',
      include: '{"notes":{"include":{"note_events":true}}}',
    });
    expect(
      encodeDatabaseRecordQuery({
        select: ["id"],
        ...({ where: { id: 1 }, limit: 1 } as object),
      }),
    ).toBe(new URLSearchParams({ select: '["id"]' }).toString());
  });
});

describe("databaseErrorCategoryForStatus", () => {
  it("reads every generated status back into its stable category", () => {
    expect(
      [400, 403, 404, 409, 413, 415, 422, 503].map(
        databaseErrorCategoryForStatus,
      ),
    ).toEqual([
      "INVALID_REQUEST",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PAYLOAD_TOO_LARGE",
      "UNSUPPORTED_MEDIA_TYPE",
      "VALIDATION_FAILED",
      "TRANSIENT",
    ]);
  });

  it("treats any other status as INTERNAL", () => {
    expect(databaseErrorCategoryForStatus(500)).toBe("INTERNAL");
    expect(databaseErrorCategoryForStatus(502)).toBe("INTERNAL");
    expect(databaseErrorCategoryForStatus(401)).toBe("INTERNAL");
  });
});
