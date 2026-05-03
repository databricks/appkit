import { describe, expect, test } from "vitest";
import { buildRlsScaffold, compileRlsExpression } from "../rls";

describe("compileRlsExpression", () => {
  test("expands owner shorthand to current_user_id()", () => {
    expect(compileRlsExpression("owner:userId")).toBe(
      "userId = current_user_id()",
    );
  });

  test("expands tenant shorthand to current_tenant_id()", () => {
    expect(compileRlsExpression("tenant:orgId")).toBe(
      "orgId = current_tenant_id()",
    );
  });

  test("passes through raw SQL", () => {
    expect(compileRlsExpression("status <> 'archived'")).toBe(
      "status <> 'archived'",
    );
  });

  test("rejects empty spec", () => {
    expect(() => compileRlsExpression("   ")).toThrow();
  });

  test("treats unknown prefixes as raw SQL", () => {
    expect(compileRlsExpression("group:teamId")).toBe("group:teamId");
  });
});

describe("buildRlsScaffold", () => {
  test("emits an idempotent migration with quoted identifiers", () => {
    const scaffold = buildRlsScaffold({
      entity: "user",
      tableName: "user",
      policyName: "user_self_only",
      spec: "owner:id",
    });
    expect(scaffold.migrationSql).toContain(
      'ALTER TABLE "app"."user" ENABLE ROW LEVEL SECURITY;',
    );
    expect(scaffold.migrationSql).toContain(
      'DROP POLICY IF EXISTS "user_self_only" ON "app"."user";',
    );
    expect(scaffold.migrationSql).toContain("FOR ALL");
    expect(scaffold.migrationSql).toContain("USING (id = current_user_id());");
  });

  test("honours custom schema and verb subset", () => {
    const scaffold = buildRlsScaffold({
      entity: "case",
      tableName: "cases",
      schemaName: "public",
      policyName: "cases_owner_select",
      spec: "owner:assigned_to",
      actions: ["select"],
    });
    expect(scaffold.migrationSql).toContain('ALTER TABLE "public"."cases"');
    expect(scaffold.migrationSql).toContain("FOR SELECT");
  });

  test("schemaTsInsert references the entity binding from defineSchema", () => {
    const scaffold = buildRlsScaffold({
      entity: "team",
      tableName: "team",
      policyName: "team_member_can_read",
      spec: "tenant:orgId",
      actions: ["select"],
    });
    expect(scaffold.schemaTsInsert).toContain('policy("team_member_can_read")');
    expect(scaffold.schemaTsInsert).toContain(".on(team)");
    expect(scaffold.schemaTsInsert).toContain('.for("select")');
    expect(scaffold.schemaTsInsert).toContain(
      `.using(() => "orgId = current_tenant_id()")`,
    );
  });
});
