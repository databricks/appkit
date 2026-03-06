import { describe, expect, test } from "vitest";
import {
  contentTypeFromPath,
  isTextContentType,
  parentDirectory,
  sanitizeFilename,
} from "../helpers";

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
    expect(contentTypeFromPath("/archive.tar.gz")).toBe("application/gzip");
    expect(contentTypeFromPath("/data.backup.json")).toBe("application/json");
  });

  test("resolves .ico to IANA standard type", () => {
    expect(contentTypeFromPath("/favicon.ico")).toBe(
      "image/vnd.microsoft.icon",
    );
  });

  test("resolves Databricks-relevant file types", () => {
    expect(contentTypeFromPath("/config.yaml")).toBe("application/x-yaml");
    expect(contentTypeFromPath("/config.yml")).toBe("application/x-yaml");
    expect(contentTypeFromPath("/query.sql")).toBe("application/sql");
    expect(contentTypeFromPath("/data.parquet")).toBe(
      "application/vnd.apache.parquet",
    );
    expect(contentTypeFromPath("/events.jsonl")).toBe("application/x-ndjson");
    expect(contentTypeFromPath("/notebook.ipynb")).toBe(
      "application/x-ipynb+json",
    );
    expect(contentTypeFromPath("/script.py")).toBe("text/x-python");
    expect(contentTypeFromPath("/archive.zip")).toBe("application/zip");
    expect(contentTypeFromPath("/data.gz")).toBe("application/gzip");
    expect(contentTypeFromPath("/app.ts")).toBe("text/typescript");
  });

  test("custom types override defaults", () => {
    const custom = { ".json": "text/json", ".custom": "application/custom" };
    expect(contentTypeFromPath("/data.json", undefined, custom)).toBe(
      "text/json",
    );
    expect(contentTypeFromPath("/file.custom", undefined, custom)).toBe(
      "application/custom",
    );
  });

  test("falls back to defaults when custom types don't match", () => {
    const custom = { ".custom": "application/custom" };
    expect(contentTypeFromPath("/data.json", undefined, custom)).toBe(
      "application/json",
    );
  });

  test("custom types take priority over reported type", () => {
    const custom = { ".xyz": "application/xyz" };
    expect(contentTypeFromPath("/file.xyz", "text/plain", custom)).toBe(
      "application/xyz",
    );
  });
});

describe("isTextContentType", () => {
  test("returns false for undefined", () => {
    expect(isTextContentType(undefined)).toBe(false);
  });

  test("returns true for text/* types", () => {
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("text/html")).toBe(true);
    expect(isTextContentType("text/markdown")).toBe(true);
    expect(isTextContentType("text/x-python")).toBe(true);
    expect(isTextContentType("text/typescript")).toBe(true);
  });

  test("returns true for text-based application/ types", () => {
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("application/xml")).toBe(true);
    expect(isTextContentType("application/sql")).toBe(true);
    expect(isTextContentType("application/javascript")).toBe(true);
    expect(isTextContentType("application/x-yaml")).toBe(true);
    expect(isTextContentType("application/x-ndjson")).toBe(true);
    expect(isTextContentType("application/x-ipynb+json")).toBe(true);
  });

  test("returns false for binary application/ types", () => {
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("application/zip")).toBe(false);
    expect(isTextContentType("application/gzip")).toBe(false);
    expect(isTextContentType("application/octet-stream")).toBe(false);
    expect(isTextContentType("application/vnd.apache.parquet")).toBe(false);
  });

  test("returns false for image types", () => {
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("image/jpeg")).toBe(false);
  });
});

describe("parentDirectory", () => {
  test("extracts parent from nested path", () => {
    expect(parentDirectory("/Volumes/catalog/schema/vol/file.txt")).toBe(
      "/Volumes/catalog/schema/vol",
    );
  });

  test("extracts parent from two-segment path", () => {
    expect(parentDirectory("/dir/file.txt")).toBe("/dir");
  });

  test("returns root for root-level file", () => {
    expect(parentDirectory("/file.txt")).toBe("/");
  });

  test("returns empty string for relative path without slash", () => {
    expect(parentDirectory("file.txt")).toBe("");
  });

  test("strips trailing slash before computing parent", () => {
    expect(parentDirectory("/dir/subdir/")).toBe("/dir");
  });

  test("handles root path with trailing slash", () => {
    expect(parentDirectory("/")).toBe("/");
  });

  test("handles relative nested path", () => {
    expect(parentDirectory("subdir/file.txt")).toBe("subdir");
  });
});

describe("sanitizeFilename", () => {
  test("passes through clean filenames unchanged", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("my-file_v2.txt")).toBe("my-file_v2.txt");
  });

  test("escapes double quotes", () => {
    expect(sanitizeFilename('file"name.txt')).toBe('file\\"name.txt');
  });

  test("escapes backslashes", () => {
    expect(sanitizeFilename("file\\name.txt")).toBe("file\\\\name.txt");
  });

  test("strips carriage returns and newlines", () => {
    expect(sanitizeFilename("file\r\nname.txt")).toBe("filename.txt");
    expect(sanitizeFilename("file\rname.txt")).toBe("filename.txt");
    expect(sanitizeFilename("file\nname.txt")).toBe("filename.txt");
  });

  test("handles combined special characters", () => {
    expect(sanitizeFilename('a"b\\c\r\nd.txt')).toBe('a\\"b\\\\cd.txt');
  });
});
