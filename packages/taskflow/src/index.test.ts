import { describe, expect, it } from "vitest";
import { hello } from "./index";

describe("hello", () => {
  it("should return a greeting", () => {
    expect(hello("World")).toBe("Hello, World!");
  });
});
