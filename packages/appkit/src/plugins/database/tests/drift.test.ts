import type { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { defineSchema, id, text } from "../../../database";
import type { IntrospectionResult } from "../../../database/introspector";
import { ConfigurationError } from "../../../errors";
import { checkDrift } from "../drift";

const declared = defineSchema(({ table }) => ({
  user: table("user", {
    id: id(),
    email: text().notNull(),
  }),
}));

function liveSnapshot(extra: IntrospectionResult["tables"] = []) {
  return {
    schemas: ["app"],
    tables: [
      {
        schema: "app",
        name: "user",
        policies: [],
        columns: [
          {
            name: "id",
            pgType: "int4",
            nullable: false,
            hasDefault: true,
            isPrimaryKey: true,
            serverGenerated: true,
          },
          {
            name: "email",
            pgType: "text",
            nullable: false,
            hasDefault: false,
          },
        ],
      },
      ...extra,
    ],
  } satisfies IntrospectionResult;
}

describe("checkDrift", () => {
  test("returns a clean report when live and declared schemas match", async () => {
    await expect(
      checkDrift({
        pool: {} as Pool,
        schema: declared,
        introspectFn: async () => liveSnapshot(),
      }),
    ).resolves.toEqual({ hasDrift: false, entries: [] });
  });

  test("returns drift in development without throwing", async () => {
    const report = await checkDrift({
      pool: {} as Pool,
      schema: declared,
      nodeEnv: "development",
      introspectFn: async () =>
        liveSnapshot([
          { schema: "app", name: "audit_log", policies: [], columns: [] },
        ]),
    });

    expect(report.hasDrift).toBe(true);
    expect(report.entries[0]?.message).toContain("audit_log");
  });

  test("throws in production when drift is detected", async () => {
    await expect(
      checkDrift({
        pool: {} as Pool,
        schema: declared,
        nodeEnv: "production",
        introspectFn: async () =>
          liveSnapshot([
            { schema: "app", name: "audit_log", policies: [], columns: [] },
          ]),
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  test("skips the live check when disabled", async () => {
    const report = await checkDrift({
      pool: {} as Pool,
      schema: declared,
      enabled: false,
      introspectFn: async () => {
        throw new Error("should not introspect");
      },
    });

    expect(report).toEqual({ hasDrift: false, entries: [] });
  });
});
