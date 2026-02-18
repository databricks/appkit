import { describe, expect, test } from "vitest";
import { contentTypeFromPath } from "../helpers";

describe("contentTypeFromPath", () => {
  test("works without reported type", () => {
    expect(contentTypeFromPath("/data.json")).toBe("application/json");
  });

  test("returns application/octet-stream for unknown extensions with no reported type", () => {
    expect(contentTypeFromPath("/file.xyz")).toBe("application/octet-stream");
  });

  test("handles case-insensitive extensions", () => {
    expect(contentTypeFromPath("/image.PNG")).toBe("image/png");
    expect(contentTypeFromPath("/data.Json")).toBe("application/json");
  });

  test("uses extension when reported is undefined", () => {
    expect(contentTypeFromPath("/style.css", undefined)).toBe("text/css");
  });

  test("prefers extension type over reported type for known extensions", () => {
    // Extension takes priority to prevent MIME type mismatch attacks
    expect(contentTypeFromPath("/file.json", "text/html")).toBe(
      "application/json",
    );
  });

  test("falls back to reported type for unknown extensions", () => {
    expect(contentTypeFromPath("/file.xyz", "text/plain")).toBe("text/plain");
  });

  test("handles paths with multiple dots", () => {
    expect(contentTypeFromPath("/archive.tar.gz")).toBe(
      "application/octet-stream",
    );
    expect(contentTypeFromPath("/data.backup.json")).toBe("application/json");
  });
});
