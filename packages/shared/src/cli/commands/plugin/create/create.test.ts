import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildResourceFromType,
  parseResourcesJson,
  parseResourcesShorthand,
  printNextSteps,
} from "./create";
import type { CreateAnswers } from "./types";

describe("create non-interactive helpers", () => {
  describe("buildResourceFromType", () => {
    it("builds a sql_warehouse resource with correct defaults", () => {
      const resource = buildResourceFromType("sql_warehouse");
      expect(resource.type).toBe("sql_warehouse");
      expect(resource.required).toBe(true);
      expect(resource.resourceKey).toBe("sql-warehouse");
      expect(resource.permission).toBe("CAN_USE");
      expect(resource.fields.id.env).toBe("DATABRICKS_WAREHOUSE_ID");
    });

    it("builds a volume resource with correct defaults", () => {
      const resource = buildResourceFromType("volume");
      expect(resource.type).toBe("volume");
      expect(resource.resourceKey).toBe("volume");
      expect(resource.fields.name.env).toBe("VOLUME_NAME");
    });

    it("builds an unknown type with a fallback pattern", () => {
      const resource = buildResourceFromType("custom_thing");
      expect(resource.type).toBe("custom_thing");
      expect(resource.resourceKey).toBe("custom-thing");
      expect(resource.permission).toBe("CAN_VIEW");
      expect(resource.fields.id.env).toBe("DATABRICKS_CUSTOM_THING_ID");
    });
  });

  describe("parseResourcesShorthand", () => {
    it("parses comma-separated resource types", () => {
      const resources = parseResourcesShorthand("sql_warehouse,volume");
      expect(resources).toHaveLength(2);
      expect(resources[0].type).toBe("sql_warehouse");
      expect(resources[1].type).toBe("volume");
    });

    it("trims whitespace around types", () => {
      const resources = parseResourcesShorthand(" sql_warehouse , volume ");
      expect(resources).toHaveLength(2);
      expect(resources[0].type).toBe("sql_warehouse");
      expect(resources[1].type).toBe("volume");
    });

    it("filters empty segments", () => {
      const resources = parseResourcesShorthand("sql_warehouse,,volume,");
      expect(resources).toHaveLength(2);
    });

    it("returns empty array for empty string", () => {
      const resources = parseResourcesShorthand("");
      expect(resources).toHaveLength(0);
    });
  });

  describe("parseResourcesJson", () => {
    it("parses minimal JSON with only type", () => {
      const resources = parseResourcesJson('[{"type":"sql_warehouse"}]');
      expect(resources).toHaveLength(1);
      expect(resources[0].type).toBe("sql_warehouse");
      expect(resources[0].required).toBe(true);
      expect(resources[0].permission).toBe("CAN_USE");
      expect(resources[0].resourceKey).toBe("sql-warehouse");
    });

    it("allows overriding individual fields", () => {
      const json = JSON.stringify([
        {
          type: "sql_warehouse",
          required: false,
          permission: "CAN_MANAGE",
          description: "Custom desc",
        },
      ]);
      const resources = parseResourcesJson(json);
      expect(resources[0].required).toBe(false);
      expect(resources[0].permission).toBe("CAN_MANAGE");
      expect(resources[0].description).toBe("Custom desc");
      expect(resources[0].resourceKey).toBe("sql-warehouse");
    });

    it("parses multiple resources", () => {
      const json = JSON.stringify([
        { type: "sql_warehouse" },
        { type: "volume", required: false },
      ]);
      const resources = parseResourcesJson(json);
      expect(resources).toHaveLength(2);
      expect(resources[0].type).toBe("sql_warehouse");
      expect(resources[1].type).toBe("volume");
      expect(resources[1].required).toBe(false);
    });

    it("exits on null entries in the array", () => {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      try {
        expect(() => parseResourcesJson('[null, {"type":"volume"}]')).toThrow(
          "process.exit(1)",
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("entry 0 is not an object"),
        );
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("exits on unknown resource type", () => {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      try {
        expect(() =>
          parseResourcesJson('[{"type":"not_a_real_type"}]'),
        ).toThrow("process.exit(1)");
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('Unknown resource type "not_a_real_type"'),
        );
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("parseResourcesShorthand", () => {
    it("exits on unknown resource type", () => {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      try {
        expect(() =>
          parseResourcesShorthand("sql_warehouse,fake_type"),
        ).toThrow("process.exit(1)");
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining('Unknown resource type "fake_type"'),
        );
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("printNextSteps", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const answers: CreateAnswers = {
      placement: "isolated",
      targetPath: "plugins/my-plugin",
      name: "myPlugin",
      displayName: "My Plugin",
      description: "Test plugin",
      resources: [],
      version: "0.1.0",
    };

    const targetDir = "/home/user/project/plugins/my-plugin";

    it("shows pnpm commands when pm is pnpm", () => {
      printNextSteps(answers, targetDir, "pnpm");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("pnpm install"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("pnpm run build"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("pnpm add"),
      );
    });

    it("shows npm commands when pm is npm", () => {
      printNextSteps(answers, targetDir, "npm");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm run build"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install"),
      );
    });

    it("shows yarn commands when pm is yarn", () => {
      printNextSteps(answers, targetDir, "yarn");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("yarn install"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("yarn run build"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("yarn add"),
      );
    });

    it("shows bun commands when pm is bun", () => {
      printNextSteps(answers, targetDir, "bun");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("bun install"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("bun run build"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("bun add"),
      );
    });

    it("shows npx for in-repo placement (PM-neutral)", () => {
      const inRepoAnswers = { ...answers, placement: "in-repo" as const };
      printNextSteps(inRepoAnswers, targetDir, "npm");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("npx appkit plugin sync"),
      );
    });
  });
});
