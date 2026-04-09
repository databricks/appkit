import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  extractServingEndpoints,
  findServerFile,
} from "../server-file-extractor";

describe("findServerFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns server/index.ts when it exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith(path.join("server", "index.ts")),
    );
    expect(findServerFile("/app")).toBe(
      path.join("/app", "server", "index.ts"),
    );
  });

  test("returns server/server.ts when index.ts does not exist", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith(path.join("server", "server.ts")),
    );
    expect(findServerFile("/app")).toBe(
      path.join("/app", "server", "server.ts"),
    );
  });

  test("returns null when no server file exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(findServerFile("/app")).toBeNull();
  });
});

describe("extractServingEndpoints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockServerFile(content: string) {
    vi.spyOn(fs, "readFileSync").mockReturnValue(content);
  }

  test("extracts inline endpoints from serving() call", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [
    serving({
      endpoints: {
        demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
        second: { env: "DATABRICKS_SERVING_ENDPOINT_SECOND" },
      }
    }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toEqual({
      demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      second: { env: "DATABRICKS_SERVING_ENDPOINT_SECOND" },
    });
  });

  test("extracts servedModel when present", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [
    serving({
      endpoints: {
        demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME", servedModel: "my-model" },
      }
    }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toEqual({
      demo: {
        env: "DATABRICKS_SERVING_ENDPOINT_NAME",
        servedModel: "my-model",
      },
    });
  });

  test("returns null when serving() has no arguments", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [serving()],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toBeNull();
  });

  test("returns null when serving() has config but no endpoints", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [
    serving({ timeout: 5000 }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toBeNull();
  });

  test("returns null when serving() has empty config object", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [serving({})],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toBeNull();
  });

  test("returns null when endpoints is a variable reference", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

const myEndpoints = { demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" } };
createApp({
  plugins: [
    serving({ endpoints: myEndpoints }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toBeNull();
  });

  test("returns null when no serving() call exists", () => {
    mockServerFile(`
import { createApp, analytics } from '@databricks/appkit';

createApp({
  plugins: [analytics({})],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toBeNull();
  });

  test("returns null when server file cannot be read", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = extractServingEndpoints("/app/server/nonexistent.ts");
    expect(result).toBeNull();
  });

  test("handles single-quoted env values", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [
    serving({
      endpoints: {
        demo: { env: 'DATABRICKS_SERVING_ENDPOINT_NAME' },
      }
    }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toEqual({
      demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
    });
  });

  test("handles endpoints with trailing commas", () => {
    mockServerFile(`
import { createApp, serving } from '@databricks/appkit';

createApp({
  plugins: [
    serving({
      endpoints: {
        demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
        second: { env: "DATABRICKS_SERVING_ENDPOINT_SECOND" },
      },
    }),
  ],
});
`);

    const result = extractServingEndpoints("/app/server/index.ts");
    expect(result).toEqual({
      demo: { env: "DATABRICKS_SERVING_ENDPOINT_NAME" },
      second: { env: "DATABRICKS_SERVING_ENDPOINT_SECOND" },
    });
  });
});
