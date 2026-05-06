import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildHelpersMigrationSql,
  buildRlsScaffold,
  compileRlsExpression,
  ensureRlsHelpersMigration,
  writeMigration,
} from "../rls";

describe("compileRlsExpression", () => {
  test("expands owner_email shorthand to schema-qualified current_user_email()", () => {
    expect(compileRlsExpression("owner_email:email").sql).toBe(
      `email = "app".current_user_email()`,
    );
  });

  test("honours custom schema in the qualified function reference", () => {
    expect(
      compileRlsExpression("owner_email:author", { schemaName: "tenant_a" })
        .sql,
    ).toBe(`author = "tenant_a".current_user_email()`);
  });

  test("returns the matched shorthand column for downstream validation", () => {
    expect(compileRlsExpression("owner_email:authorEmail")).toEqual({
      sql: expect.any(String),
      shorthandColumn: "authorEmail",
    });
  });

  test("rejects the legacy owner: shorthand with a clear error", () => {
    expect(() => compileRlsExpression("owner:userId")).toThrow(
      /owner: \/ tenant: shorthands were removed/,
    );
  });

  test("rejects the legacy tenant: shorthand", () => {
    expect(() => compileRlsExpression("tenant:orgId")).toThrow(
      /shorthands were removed/,
    );
  });

  test("passes through safe raw SQL", () => {
    expect(compileRlsExpression("status <> 'archived'").sql).toBe(
      "status <> 'archived'",
    );
  });

  test("rejects raw SQL containing semicolons", () => {
    expect(() => compileRlsExpression("true; drop table users")).toThrow(
      /must not contain ';'/,
    );
  });

  test("rejects raw SQL containing comments", () => {
    expect(() => compileRlsExpression("true -- bypass")).toThrow(
      /SQL comments/,
    );
    expect(() => compileRlsExpression("true /* bypass */")).toThrow(
      /SQL comments/,
    );
  });

  test("rejects raw SQL with unbalanced parens", () => {
    expect(() => compileRlsExpression("(a = 1")).toThrow(/Unbalanced/);
    expect(() => compileRlsExpression("a = 1)")).toThrow(/Unbalanced/);
  });

  test("rejects empty spec", () => {
    expect(() => compileRlsExpression("   ")).toThrow();
  });
});

describe("buildRlsScaffold", () => {
  test("emits ENABLE + FORCE + idempotent CREATE POLICY for FOR ALL", () => {
    const scaffold = buildRlsScaffold({
      entity: "user",
      tableName: "user",
      policyName: "user_self_only",
      spec: "owner_email:email",
    });
    const sql = scaffold.migrationSql;
    expect(sql).toContain('ALTER TABLE "app"."user" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "app"."user" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "user_self_only" ON "app"."user";',
    );
    expect(sql).toContain(`CREATE POLICY "user_self_only"`);
    expect(sql).toContain("FOR ALL");
    expect(sql).toContain("USING (email =");
    expect(sql).toContain("WITH CHECK (email =");
  });

  test("INSERT emits WITH CHECK only (USING is invalid)", () => {
    const scaffold = buildRlsScaffold({
      entity: "post",
      tableName: "post",
      policyName: "post_owner_insert",
      spec: "owner_email:author_email",
      actions: ["insert"],
    });
    expect(scaffold.migrationSql).toContain("FOR INSERT");
    expect(scaffold.migrationSql).toContain("WITH CHECK (author_email =");
    expect(scaffold.migrationSql).not.toContain("USING (author_email =");
  });

  test("SELECT and DELETE emit USING only", () => {
    const sql = buildRlsScaffold({
      entity: "row",
      tableName: "row",
      policyName: "row_select",
      spec: "owner_email:owner",
      actions: ["select"],
    }).migrationSql;
    expect(sql).toContain("FOR SELECT");
    expect(sql).toContain("USING (owner =");
    expect(sql).not.toContain("WITH CHECK");
  });

  test("UPDATE emits both USING and WITH CHECK to lock pre- and post-image", () => {
    const sql = buildRlsScaffold({
      entity: "row",
      tableName: "row",
      policyName: "row_update",
      spec: "owner_email:owner",
      actions: ["update"],
    }).migrationSql;
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("USING (owner =");
    expect(sql).toContain("WITH CHECK (owner =");
  });

  test("multi-verb emits one CREATE POLICY per verb with derived names", () => {
    const sql = buildRlsScaffold({
      entity: "case",
      tableName: "cases",
      policyName: "cases_owner",
      spec: "owner_email:assigned_to",
      actions: ["select", "update"],
    }).migrationSql;
    expect(sql).toContain('CREATE POLICY "cases_owner_select"');
    expect(sql).toContain("FOR SELECT");
    expect(sql).toContain('CREATE POLICY "cases_owner_update"');
    expect(sql).toContain("FOR UPDATE");
    expect(sql).not.toContain("FOR ALL");
  });

  test("custom schema flows into the policy SQL", () => {
    const sql = buildRlsScaffold({
      entity: "case",
      tableName: "cases",
      schemaName: "public",
      policyName: "cases_owner_select",
      spec: "owner_email:assigned_to_email",
      actions: ["select"],
    }).migrationSql;
    expect(sql).toContain('ALTER TABLE "public"."cases"');
    expect(sql).toContain(
      `USING (assigned_to_email = "public".current_user_email())`,
    );
  });

  test("rejects policy names containing path separators", () => {
    expect(() =>
      buildRlsScaffold({
        entity: "user",
        tableName: "user",
        policyName: "../../etc/passwd",
        spec: "owner_email:email",
      }),
    ).toThrow(/Policy name must match/);
  });

  test("rejects policy names with spaces or unsafe chars", () => {
    expect(() =>
      buildRlsScaffold({
        entity: "user",
        tableName: "user",
        policyName: "foo bar",
        spec: "owner_email:email",
      }),
    ).toThrow(/Policy name must match/);
  });
});

describe("buildHelpersMigrationSql", () => {
  test("schema-qualifies the function definition so search_path can't reroute it", () => {
    expect(buildHelpersMigrationSql("app")).toContain(
      `CREATE OR REPLACE FUNCTION "app".current_user_email()`,
    );
    expect(buildHelpersMigrationSql("tenant_a")).toContain(
      `CREATE OR REPLACE FUNCTION "tenant_a".current_user_email()`,
    );
  });

  test("does not emit current_tenant_id() (removed in this layer)", () => {
    expect(buildHelpersMigrationSql("app")).not.toContain("current_tenant_id");
  });
});

/* ============================================================ */
/* Filesystem + journal — tmpdir-backed                          */
/* ============================================================ */

describe("writeMigration + ensureRlsHelpersMigration", () => {
  let migrationsDir: string;

  beforeEach(() => {
    migrationsDir = mkdtempSync(path.join(tmpdir(), "appkit-rls-fs-"));
  });

  afterEach(() => {
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  test("first run creates helpers migration and registers it in the journal", () => {
    const filePath = ensureRlsHelpersMigration(migrationsDir, "app");
    expect(filePath).not.toBeNull();
    expect(existsSync(filePath as string)).toBe(true);
    expect(path.basename(filePath as string)).toBe(
      "0000_appkit_rls_helpers.sql",
    );

    const journal = readJournal(migrationsDir);
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      tag: "0000_appkit_rls_helpers",
      breakpoints: false,
    });
  });

  test("re-running returns null and does not duplicate the journal entry", () => {
    ensureRlsHelpersMigration(migrationsDir, "app");
    expect(ensureRlsHelpersMigration(migrationsDir, "app")).toBeNull();
    expect(readJournal(migrationsDir).entries).toHaveLength(1);
  });

  test("writeMigration registers each policy file in the journal", () => {
    ensureRlsHelpersMigration(migrationsDir, "app");
    const policySql = "-- placeholder";
    const policyPath = writeMigration(
      migrationsDir,
      "user",
      "user_owner_email",
      policySql,
    );
    expect(path.basename(policyPath)).toBe(
      "0001_rls_user_user_owner_email.sql",
    );

    const journal = readJournal(migrationsDir);
    expect(journal.entries.map((e) => e.tag)).toEqual([
      "0000_appkit_rls_helpers",
      "0001_rls_user_user_owner_email",
    ]);
    expect(journal.entries.map((e) => e.idx)).toEqual([0, 1]);
  });

  test("nextMigrationNumber outruns both journal and orphaned on-disk files", () => {
    writeFileSync(
      path.join(migrationsDir, "0007_orphan.sql"),
      "-- not journaled",
      "utf8",
    );
    const filePath = ensureRlsHelpersMigration(migrationsDir, "app");
    expect(path.basename(filePath as string)).toBe(
      "0008_appkit_rls_helpers.sql",
    );
  });

  test("refuses migration tags containing path separators", () => {
    expect(() =>
      writeMigration(migrationsDir, "user", "../escape", "-- placeholder"),
    ).toThrow(/Refusing to write migration tag/);
  });

  test("preserves a pre-existing journal with non-rls entries", () => {
    seedJournal(migrationsDir, [
      { idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true },
    ]);
    const filePath = ensureRlsHelpersMigration(migrationsDir, "app");
    expect(path.basename(filePath as string)).toBe(
      "0001_appkit_rls_helpers.sql",
    );
    const journal = readJournal(migrationsDir);
    expect(journal.entries.map((e) => e.tag)).toEqual([
      "0000_init",
      "0001_appkit_rls_helpers",
    ]);
  });
});

interface JournalShape {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

function readJournal(migrationsDir: string): JournalShape {
  return JSON.parse(
    readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  );
}

function seedJournal(
  migrationsDir: string,
  entries: JournalShape["entries"],
): void {
  const metaDir = path.join(migrationsDir, "meta");
  if (!existsSync(metaDir)) {
    require("node:fs").mkdirSync(metaDir, { recursive: true });
  }
  writeFileSync(
    path.join(metaDir, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2),
    "utf8",
  );
  for (const entry of entries) {
    const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      writeFileSync(sqlPath, "-- seed", "utf8");
    }
  }
  void readdirSync(migrationsDir);
}
