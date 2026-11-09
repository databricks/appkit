import { describe, expect, test } from "vitest";

import { selectActorBoundary } from "../operation-actor";

describe("selectActorBoundary", () => {
  const host = "workspace.cloud.databricks.com";

  test("a deployed Databricks App verifies forwarded user tokens with its workspace", () => {
    expect(
      selectActorBoundary(host, {
        NODE_ENV: "production",
        DATABRICKS_APP_NAME: "notes",
      }),
    ).toEqual({ kind: "apps", host: `https://${host}` });
  });

  test("local development needs explicit credentials and keeps local OBO switchable", () => {
    const local = selectActorBoundary(`https://${host}/`, {
      NODE_ENV: "development",
      DATABRICKS_CONFIG_PROFILE: "dev",
    });
    expect(local).toMatchObject({ kind: "local", host: `https://${host}` });

    for (const env of [
      { NODE_ENV: "development" },
      { NODE_ENV: "development", DATABRICKS_TOKEN: "  " },
      {
        NODE_ENV: "development",
        DATABRICKS_TOKEN: "dapi-dev",
        APPKIT_DEV_OBO: "false",
      },
    ]) {
      expect(selectActorBoundary(host, env)).toEqual({ kind: "unsupported" });
    }
  });

  test("any other hosting, or no workspace, authenticates no one", () => {
    expect(selectActorBoundary(host, { NODE_ENV: "production" })).toEqual({
      kind: "unsupported",
    });
    // Request headers alone never select a boundary.
    expect(
      selectActorBoundary(host, {
        NODE_ENV: "production",
        HTTP_X_FORWARDED_ACCESS_TOKEN: "t",
      }),
    ).toEqual({ kind: "unsupported" });
    expect(
      selectActorBoundary(undefined, {
        NODE_ENV: "production",
        DATABRICKS_APP_NAME: "notes",
      }),
    ).toEqual({ kind: "unsupported" });
    expect(
      selectActorBoundary("http://[bad", {
        NODE_ENV: "production",
        DATABRICKS_APP_NAME: "notes",
      }),
    ).toEqual({ kind: "unsupported" });
  });
});
