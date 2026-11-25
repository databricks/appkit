import { describe, expect, test } from "vitest";

import { developmentBranchKind } from "../branch-names";

describe("developmentBranchKind", () => {
  // The names `appkit db init` generates, at the edges of its naming rules.
  test.each([
    ["a person's dev branch", "dev-jane-a1b2c3"],
    ["a dev branch from a dotted local part", "dev-jane-doe-2-a1b2c3"],
    ["the fallback slug when nothing is left", "dev-user-a1b2c3"],
    [
      "a service principal's application id",
      "dev-0a1b2c3d-4e5f-6789-abcd-ef0123456789-a1b2c3",
    ],
    ["a slug cut to 52 characters, 63 in all", `dev-${"a".repeat(52)}-a1b2c3`],
  ])("%s is a dev branch", (_label, branch) => {
    expect(developmentBranchKind(branch)).toBe("dev");
  });

  test.each([
    ["a generated 8-character id", "session-a1b2c3-k3x9q2m7"],
    ["a one-character id set by hand", "session-a1b2c3-x"],
    ["a 48-character id, 63 in all", `session-a1b2c3-${"z9".repeat(24)}`],
  ])("%s is a session branch", (_label, branch) => {
    expect(developmentBranchKind(branch)).toBe("session");
  });

  test.each([
    ["the production branch", "production"],
    ["a branch that only starts with dev-", "dev-environment"],
    ["a dev- branch without six hex characters", "dev-jane-a1b2c"],
    ["a dev- branch with an uppercase hash", "dev-jane-A1B2C3"],
    ["a dev- shape over 63 characters", `dev-${"a".repeat(53)}-a1b2c3`],
    ["a session- branch that is not an agent session", "session-store"],
    ["a session- branch with no hash", "session-k3x9q2m7"],
    ["a session id over 48 characters", `session-a1b2c3-${"a".repeat(49)}`],
  ])("%s is neither", (_label, branch) => {
    expect(developmentBranchKind(branch)).toBeUndefined();
  });
});
