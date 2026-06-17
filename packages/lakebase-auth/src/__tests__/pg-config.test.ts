import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getPgConfig } from "../pg-config";
import type { Credential } from "../types";

const ENV_KEYS = [
  "PGHOST",
  "PGDATABASE",
  "LAKEBASE_ENDPOINT",
  "PGUSER",
  "PGPORT",
  "PGSSLMODE",
  "DATABRICKS_CLIENT_ID",
] as const;

const original: Record<string, string | undefined> = {};

function fakeFetch(token = "tok"): () => Promise<Credential> {
  return vi.fn(async () => ({ token, expiresAt: Date.now() + 3_600_000 }));
}

describe("getPgConfig", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.PGHOST = "ep-test.databricks.com";
    process.env.PGDATABASE = "databricks_postgres";
    process.env.LAKEBASE_ENDPOINT =
      "projects/test/branches/main/endpoints/primary";
    process.env.PGUSER = "user@example.com";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  test("builds a pg config from environment variables", () => {
    const cfg = getPgConfig({ fetchCredential: fakeFetch(), refresh: "lazy" });

    expect(cfg.host).toBe("ep-test.databricks.com");
    expect(cfg.database).toBe("databricks_postgres");
    expect(cfg.user).toBe("user@example.com");
    expect(cfg.port).toBe(5432);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(typeof cfg.password).toBe("function");

    cfg.dispose();
  });

  test("password callback resolves to the fetched token", async () => {
    const fetchCredential = fakeFetch("the-token");
    const cfg = getPgConfig({ fetchCredential, refresh: "lazy" });

    const password = cfg.password as () => Promise<string>;
    await expect(password()).resolves.toBe("the-token");
    expect(fetchCredential).toHaveBeenCalledTimes(1);

    cfg.dispose();
  });

  test("uses a native password without OAuth, with a no-op dispose", () => {
    const cfg = getPgConfig({
      password: "static-password",
      host: "ep-test.databricks.com",
      database: "databricks_postgres",
      user: "user@example.com",
    });

    expect(cfg.password).toBe("static-password");
    expect(() => cfg.dispose()).not.toThrow();
  });

  test("maps sslMode 'disable' to false", () => {
    const cfg = getPgConfig({
      password: "x",
      sslMode: "disable",
    });

    expect(cfg.ssl).toBe(false);
  });

  test("throws when neither endpoint nor password is provided", () => {
    delete process.env.LAKEBASE_ENDPOINT;

    expect(() => getPgConfig({ fetchCredential: fakeFetch() })).toThrow(
      "LAKEBASE_ENDPOINT or config.endpoint",
    );
  });

  test("throws when the username cannot be resolved", () => {
    delete process.env.PGUSER;
    delete process.env.DATABRICKS_CLIENT_ID;

    expect(() =>
      getPgConfig({ fetchCredential: fakeFetch(), refresh: "lazy" }),
    ).toThrow("PGUSER or DATABRICKS_CLIENT_ID");
  });
});
