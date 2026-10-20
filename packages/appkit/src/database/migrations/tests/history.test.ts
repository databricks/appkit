import { describe, expect, test } from "vitest";

import { type MigrationFile, reconcileMigrations } from "../history";

const file = (
  tag: string,
  when: number,
  hash = `hash-${tag}`,
): MigrationFile => ({
  tag,
  idx: 0,
  when,
  hash,
  statements: [],
});

const tags = (files: readonly MigrationFile[]) => files.map((f) => f.tag);

describe("reconcileMigrations", () => {
  const files = [
    file("0000_a", 1000),
    file("0001_b", 2000),
    file("0002_c", 3000),
  ];

  test("nothing recorded: every migration is pending", () => {
    const history = reconcileMigrations(files, []);
    expect(tags(history.pending)).toEqual(["0000_a", "0001_b", "0002_c"]);
    expect(history.lastRecorded).toBeNull();
  });

  test("newer than the last recorded migration: pending", () => {
    const history = reconcileMigrations(files, [
      { hash: "hash-0000_a", createdAt: 1000 },
    ]);
    expect(tags(history.pending)).toEqual(["0001_b", "0002_c"]);
    expect(history.stranded).toEqual([]);
    expect(history.lastRecorded).toBe(1000);
  });

  test("older than the last recorded migration and never recorded: stranded", () => {
    const history = reconcileMigrations(files, [
      { hash: "hash-0000_a", createdAt: 1000 },
      { hash: "hash-0002_c", createdAt: 3000 },
    ]);
    expect(tags(history.stranded)).toEqual(["0001_b"]);
    expect(history.pending).toEqual([]);
  });

  test("recorded with another hash: edited", () => {
    const history = reconcileMigrations(files, [
      { hash: "before-the-edit", createdAt: 1000 },
      { hash: "hash-0001_b", createdAt: 2000 },
      { hash: "hash-0002_c", createdAt: 3000 },
    ]);
    expect(tags(history.edited)).toEqual(["0000_a"]);
    expect(history.pending).toEqual([]);
  });

  test("recorded rows no committed migration matches: unknown, and they still set the last recorded", () => {
    const unknownRow = { hash: "newer-release", createdAt: 4000 };
    const nullRow = { hash: "no-timestamp", createdAt: null };
    const history = reconcileMigrations(files, [
      { hash: "hash-0000_a", createdAt: 1000 },
      { hash: "hash-0001_b", createdAt: 2000 },
      { hash: "hash-0002_c", createdAt: 3000 },
      unknownRow,
      nullRow,
    ]);
    expect(history.unknown).toEqual([unknownRow, nullRow]);
    expect(history.lastRecorded).toBe(4000);
    expect(history.pending).toEqual([]);
    expect(history.stranded).toEqual([]);
  });
});
