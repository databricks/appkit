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

  test("two entries with one `when` keep their own rows: both recorded is clean, one recorded strands the other", () => {
    const twins = [file("0000_a", 1000), file("0001_twin", 1000)];
    const both = reconcileMigrations(twins, [
      { hash: "hash-0000_a", createdAt: 1000 },
      { hash: "hash-0001_twin", createdAt: 1000 },
    ]);
    expect([...both.pending, ...both.stranded, ...both.edited]).toEqual([]);

    const one = reconcileMigrations(twins, [
      { hash: "hash-0000_a", createdAt: 1000 },
    ]);
    expect(tags(one.stranded)).toEqual(["0001_twin"]);
    expect(one.edited).toEqual([]);
  });

  test("one row and two unmatched files at one `when`: ambiguous, so nothing is edited, pending or stranded", () => {
    // A was applied and edited since; B was added by hand with A's timestamp.
    const twins = [
      file("0000_a", 1000, "hash-a-after-the-edit"),
      file("0001_b", 1000),
    ];
    const history = reconcileMigrations(twins, [
      { hash: "hash-0000_a", createdAt: 1000 },
    ]);
    expect(history.ambiguous).toEqual([
      { when: 1000, files: twins, recorded: 1 },
    ]);
    expect([
      ...history.pending,
      ...history.stranded,
      ...history.edited,
    ]).toEqual([]);
    expect(history.unknown).toEqual([]);
  });

  test("a second row at a committed `when` that no file matches: unknown, not edited", () => {
    const other = { hash: "hash-other", createdAt: 1000 };
    const history = reconcileMigrations(
      [file("0000_a", 1000)],
      [{ hash: "hash-0000_a", createdAt: 1000 }, other],
    );
    expect(history.unknown).toEqual([other]);
    expect(history.edited).toEqual([]);
    expect(history.ambiguous).toEqual([]);
  });

  test("two unmatched files and two unmatched rows at one `when`: ambiguous", () => {
    const twins = [
      file("0000_a", 1000, "hash-a-after-the-edit"),
      file("0001_b", 1000, "hash-b-after-the-edit"),
    ];
    const history = reconcileMigrations(twins, [
      { hash: "hash-0000_a", createdAt: 1000 },
      { hash: "hash-0001_b", createdAt: 1000 },
    ]);
    expect(history.ambiguous).toEqual([
      { when: 1000, files: twins, recorded: 2 },
    ]);
    expect(history.edited).toEqual([]);
    expect(history.unknown).toEqual([]);
  });

  test("an exact match at a shared `when` is consumed before the rest are paired, so the pair left is edited", () => {
    const twins = [
      file("0000_a", 1000),
      file("0001_b", 1000, "hash-b-after-the-edit"),
    ];
    const history = reconcileMigrations(twins, [
      { hash: "hash-0001_b", createdAt: 1000 },
      { hash: "hash-0000_a", createdAt: 1000 },
    ]);
    expect(tags(history.edited)).toEqual(["0001_b"]);
    expect(history.ambiguous).toEqual([]);
    expect(history.unknown).toEqual([]);
  });

  test("clean, pending, stranded and ambiguous timestamps classify independently", () => {
    const all = [
      file("0000_a", 1000),
      file("0001_b", 2000, "hash-b-after-the-edit"),
      file("0002_c", 2000),
      file("0003_d", 3000),
      file("0004_e", 2500),
    ];
    const history = reconcileMigrations(all, [
      { hash: "hash-0000_a", createdAt: 1000 },
      { hash: "hash-0001_b", createdAt: 2000 },
      { hash: "hash-0003_d", createdAt: 3000 },
    ]);
    expect(history.ambiguous.map((entry) => tags(entry.files))).toEqual([
      ["0001_b", "0002_c"],
    ]);
    expect(tags(history.stranded)).toEqual(["0004_e"]);
    expect(history.pending).toEqual([]);
    expect(history.edited).toEqual([]);
  });
});
