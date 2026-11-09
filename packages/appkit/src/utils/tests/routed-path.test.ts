import { describe, expect, test } from "vitest";

import { routedPath } from "../routed-path";

describe("routedPath", () => {
  test("drops the query of an origin-form target", () => {
    expect(routedPath("/api/database/operations/notes.get?input=%7B%7D")).toBe(
      "/api/database/operations/notes.get",
    );
  });

  test("drops the scheme and authority of an absolute-form target", () => {
    expect(
      routedPath("http://app.example.com:8000/API/Database/operations/x?a=1"),
    ).toBe("/API/Database/operations/x");
    expect(routedPath("HTTPS://host/api")).toBe("/api");
  });

  test("answers an empty path for a target without one", () => {
    expect(routedPath("http://host")).toBe("");
  });
});
