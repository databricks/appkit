import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPluginAddCommand,
  requestsFromArgs,
  requestsFromPlan,
} from "./add";

// bundle validate would shell out to the Databricks CLI.
vi.mock("../../registry/config-writer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry/config-writer")>()),
  validateBundle: () => true,
}));

const MANIFEST = path.resolve(
  __dirname,
  "../../../../../../../template/appkit.plugins.json",
);
const dirs: string[] = [];

function makeApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-add-run-"));
  dirs.push(dir);
  fs.copyFileSync(MANIFEST, path.join(dir, "appkit.plugins.json"));
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(
    path.join(dir, "server", "server.ts"),
    `import { createApp, server } from "@databricks/appkit";\n\ncreateApp({ plugins: [server()] });\n`,
  );
  return dir;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

describe("requestsFromArgs", () => {
  test("gives each plugin its own --set pairs", () => {
    expect(
      requestsFromArgs(
        ["analytics", "genie"],
        ["analytics.sql-warehouse.id=wh", "genie.genie-space.id=s"],
        "obo",
      ),
    ).toEqual([
      {
        name: "analytics",
        set: ["analytics.sql-warehouse.id=wh"],
        authMode: "obo",
      },
      { name: "genie", set: ["genie.genie-space.id=s"], authMode: "obo" },
    ]);
  });

  test("rejects --set for a plugin the run doesn't add", () => {
    expect(() =>
      requestsFromArgs(["analytics"], ["genie.genie-space.id=s"], undefined),
    ).toThrow("doesn't add");
  });
});

describe("requestsFromPlan", () => {
  test("maps plan entries to prefixed --set pairs", () => {
    const dir = makeApp();
    const file = path.join(dir, "plan.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            name: "analytics",
            authMode: "sp",
            set: { "sql-warehouse.id": "wh" },
          },
        ],
      }),
    );
    expect(requestsFromPlan(file)).toEqual([
      {
        name: "analytics",
        authMode: "sp",
        set: ["analytics.sql-warehouse.id=wh"],
      },
    ]);
  });

  test("rejects an unknown version or auth mode", () => {
    const dir = makeApp();
    const file = path.join(dir, "plan.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        plugins: [{ name: "a", authMode: "both" }],
      }),
    );
    expect(() => requestsFromPlan(file)).toThrow(
      /invalid data plan.*version.*authMode/s,
    );
  });
});

test("adds several plugins writing each file once, and nothing on a rerun", async () => {
  const dir = makeApp();
  fs.mkdirSync(path.join(dir, ".appkit"));
  fs.writeFileSync(
    path.join(dir, ".appkit", "data-plan.json"),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          name: "analytics",
          authMode: "obo",
          set: { "sql-warehouse.id": "wh-1" },
        },
        {
          name: "genie",
          set: { "genie-space.id": "space-1", "genie-space.name": "Sales" },
        },
      ],
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = () =>
    createPluginAddCommand().parseAsync(
      ["--from-plan", ".appkit/data-plan.json", "--yes", "-C", dir],
      { from: "user" },
    );

  const writes = vi.spyOn(fs, "writeFileSync");
  await run();
  const written = writes.mock.calls.map((c) =>
    path.relative(dir, String(c[0])),
  );
  expect(written.sort()).toEqual([
    ".env",
    "app.yaml",
    "databricks.yml",
    "server/server.ts",
  ]);

  const server = fs.readFileSync(
    path.join(dir, "server", "server.ts"),
    "utf-8",
  );
  expect(server).toContain(
    `import { createApp, server, analytics, genie } from "@databricks/appkit";`,
  );
  expect(fs.readFileSync(path.join(dir, ".env"), "utf-8")).toContain(
    "DATABRICKS_WAREHOUSE_ID=wh-1",
  );
  const yml = fs.readFileSync(path.join(dir, "databricks.yml"), "utf-8");
  expect(yml).toContain("- sql");
  expect(yml).toContain("- genie");

  writes.mockClear();
  await run();
  expect(writes).not.toHaveBeenCalled();
});

test.each([[["agents", "serving"]], [["serving", "agents"]]])(
  "agents and serving work in either order (%j)",
  async (names) => {
    const dir = makeApp();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await createPluginAddCommand().parseAsync(
      [
        ...names,
        "--set",
        "agents.agents-serving-endpoint.name=agent-model",
        "--set",
        "serving.serving-endpoint.name=serving-model",
        "--yes",
        "-C",
        dir,
      ],
      { from: "user" },
    );
    const server = fs.readFileSync(
      path.join(dir, "server", "server.ts"),
      "utf-8",
    );
    expect(server).toContain(`agents({ defaultModel: "agent-model" })`);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf-8")).toContain(
      "DATABRICKS_SERVING_ENDPOINT_NAME=serving-model",
    );
  },
);
