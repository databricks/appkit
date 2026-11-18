import { describe, expect, test } from "vitest";

import {
  hasDevQuery,
  isLocalDev,
  isRemoteTunnelAllowedByEnv,
  isRemoteTunnelAssetRequest,
} from "../remote-tunnel/gate";

describe("remote-tunnel/gate", () => {
  test("isLocalDev returns true when NODE_ENV=development", () => {
    expect(isLocalDev({ NODE_ENV: "development" } as any)).toBe(true);
    expect(isLocalDev({ NODE_ENV: "production" } as any)).toBe(false);
  });

  test("isRemoteTunnelAllowedByEnv is off by default in a deployed app", () => {
    // A deployed app: production, with the platform-injected client secret.
    expect(
      isRemoteTunnelAllowedByEnv({
        NODE_ENV: "production",
        DATABRICKS_CLIENT_SECRET: "x",
      } as any),
    ).toBe(false);

    // NODE_ENV unset (e.g. an app started without npm start) is also off.
    expect(
      isRemoteTunnelAllowedByEnv({ DATABRICKS_CLIENT_SECRET: "x" } as any),
    ).toBe(false);

    // DISABLE_REMOTE_SERVING defaults to true: only the exact string "false"
    // opts in, so typos and other spellings fail closed.
    for (const value of ["true", "False", "FALSE", "0", "no", "off", ""]) {
      expect(
        isRemoteTunnelAllowedByEnv({
          NODE_ENV: "production",
          DATABRICKS_CLIENT_SECRET: "x",
          DISABLE_REMOTE_SERVING: value,
        } as any),
      ).toBe(false);
    }
  });

  test("isRemoteTunnelAllowedByEnv requires DISABLE_REMOTE_SERVING=false, a secret, and not local dev", () => {
    expect(
      isRemoteTunnelAllowedByEnv({
        NODE_ENV: "production",
        DATABRICKS_CLIENT_SECRET: "x",
        DISABLE_REMOTE_SERVING: "false",
      } as any),
    ).toBe(true);

    expect(
      isRemoteTunnelAllowedByEnv({
        NODE_ENV: "development",
        DATABRICKS_CLIENT_SECRET: "x",
        DISABLE_REMOTE_SERVING: "false",
      } as any),
    ).toBe(false);

    expect(
      isRemoteTunnelAllowedByEnv({
        NODE_ENV: "production",
        DATABRICKS_CLIENT_SECRET: "",
        DISABLE_REMOTE_SERVING: "false",
      } as any),
    ).toBe(false);
  });

  test("hasDevQuery returns true for ?dev (blank) and ?dev=true and ?dev=<id>", () => {
    expect(hasDevQuery({ query: {} } as any)).toBe(false);
    expect(hasDevQuery({ query: { dev: "" } } as any)).toBe(true);
    expect(hasDevQuery({ query: { dev: "true" } } as any)).toBe(true);
    expect(hasDevQuery({ query: { dev: "abcd1234" } } as any)).toBe(true);
  });

  test("isRemoteTunnelAssetRequest matches known vite prefixes", () => {
    expect(
      isRemoteTunnelAssetRequest({
        originalUrl: "/@vite/client",
      } as any),
    ).toBe(true);
    expect(
      isRemoteTunnelAssetRequest({
        originalUrl: "/node_modules/.vite/deps/react.js?v=1",
      } as any),
    ).toBe(true);
    expect(
      isRemoteTunnelAssetRequest({
        originalUrl: "/api/health",
      } as any),
    ).toBe(false);
  });
});
