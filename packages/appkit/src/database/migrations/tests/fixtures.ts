import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Journal } from "../paths";

interface MigrationFixture {
  tag: string;
  when: number;
  sql: string[];
  /** Tables (name → columns) for meta/NNNN_snapshot.json. */
  snapshot?: Record<string, string[]>;
}

const folders: string[] = [];

/** Write a v7 journal with one SQL file per entry, the way drizzle-kit lays them out. */
export function writeMigrations(
  entries: MigrationFixture[],
  schemaName = "app",
): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-apply-"));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, "meta"));
  const journal: Journal = {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry, idx) => ({
      idx,
      version: "7",
      when: entry.when,
      tag: entry.tag,
      breakpoints: true,
    })),
  };
  fs.writeFileSync(
    path.join(folder, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  entries.forEach((entry, idx) => {
    fs.writeFileSync(
      path.join(folder, `${entry.tag}.sql`),
      entry.sql.join("--> statement-breakpoint\n"),
    );
    if (entry.snapshot) {
      const tables = Object.fromEntries(
        Object.entries(entry.snapshot).map(([name, columns]) => [
          `${schemaName}.${name}`,
          {
            name,
            schema: schemaName,
            columns: Object.fromEntries(columns.map((c) => [c, { name: c }])),
          },
        ]),
      );
      fs.writeFileSync(
        path.join(
          folder,
          "meta",
          `${String(idx).padStart(4, "0")}_snapshot.json`,
        ),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          tables,
          enums: {},
        }),
      );
    }
  });
  return folder;
}

/** The hash drizzle-orm's migrator records for a migration file. */
export function hashOf(folder: string, tag: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(folder, `${tag}.sql`), "utf-8"))
    .digest("hex");
}

export function removeMigrationFolders(): void {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
