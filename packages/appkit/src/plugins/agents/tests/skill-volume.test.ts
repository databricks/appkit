import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveSkillCatalog } from "../../../core/agent/skills";

/**
 * Phase 3 — catalog (UC Volume) skill source. The workspace client and the
 * files connector are mocked so the test never touches Databricks: the mock
 * connector serves a synthetic `<volume>/pdf/SKILL.md` + `reference.md`.
 */

const h = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  client: { marker: "sp-client" } as unknown,
}));

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return { ...actual, getWorkspaceClient: () => h.client };
});

vi.mock("../../../connectors/files", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../connectors/files")>();
  return {
    ...actual,
    FilesConnector: class {
      constructor(public config: { defaultVolume?: string }) {}
      list(client: unknown, dir?: string) {
        return h.list(client, dir);
      }
      read(client: unknown, filePath: string) {
        return h.read(client, filePath);
      }
    },
  };
});

// Imported after the mocks are registered.
const { AgentsPlugin } = await import("../agents");

const VOL = "/Volumes/cat/schema/skills";

beforeEach(() => {
  process.env.DATABRICKS_VOLUME_AGENT_SKILLS = undefined;
  delete process.env.DATABRICKS_VOLUME_AGENT_SKILLS;

  h.list.mockImplementation(async (_client: unknown, dir?: string) => {
    if (dir === VOL) {
      return [{ name: "pdf", is_directory: true, path: `${VOL}/pdf` }];
    }
    if (dir === `${VOL}/pdf`) {
      return [
        { name: "SKILL.md", is_directory: false, path: `${VOL}/pdf/SKILL.md` },
        {
          name: "reference.md",
          is_directory: false,
          path: `${VOL}/pdf/reference.md`,
        },
      ];
    }
    return [];
  });
  h.read.mockImplementation(async (_client: unknown, filePath: string) => {
    if (filePath === `${VOL}/pdf/SKILL.md`) {
      return "---\nname: pdf\ndescription: Work with PDFs\n---\nPDF body.";
    }
    if (filePath === `${VOL}/pdf/reference.md`) {
      return "the reference";
    }
    throw new Error(`unexpected read: ${filePath}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadVolumeSkills", () => {
  test("discovers, parses, and manifests a volume skill (SP identity)", async () => {
    const plugin = new AgentsPlugin({ dir: false, skillsVolume: VOL });
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const skills = await (plugin as any).loadVolumeSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "pdf",
      description: "Work with PDFs",
      body: "PDF body.",
      source: "volume",
      dir: `${VOL}/pdf`,
      files: ["reference.md"],
    });
    // Read as the SP client the mock hands back.
    expect(h.read).toHaveBeenCalledWith(h.client, `${VOL}/pdf/SKILL.md`);
  });

  test("returns [] when no volume is configured", async () => {
    const plugin = new AgentsPlugin({ dir: false });
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const skills = await (plugin as any).loadVolumeSkills();
    expect(skills).toEqual([]);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe("catalog resolution merges volume skills", () => {
  test("a code agent opts into a volume skill via skills:", async () => {
    const plugin = new AgentsPlugin({ dir: false, skillsVolume: VOL });
    // biome-ignore lint/suspicious/noExplicitAny: seed the global pool + call private
    (plugin as any).globalSkills = await (plugin as any).loadVolumeSkills();
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const catalog = await (plugin as any).resolveAgentSkills(
      "helper",
      { instructions: "hi", skills: ["pdf"] },
      { origin: "code" },
    );
    expect(catalog?.byAddress.has("pdf")).toBe(true);
  });
});

describe("read_skill_file reads a volume resource", () => {
  test("reads the file through the connector under SP identity", async () => {
    const plugin = new AgentsPlugin({ dir: false, skillsVolume: VOL });
    // biome-ignore lint/suspicious/noExplicitAny: call private
    const skills = await (plugin as any).loadVolumeSkills();
    const catalog = resolveSkillCatalog({
      agentName: "a",
      perAgentSkills: [],
      globalSkills: skills,
      autoInherit: true,
    });
    const entry = {
      source: "skill" as const,
      builtin: "read_skill_file" as const,
      catalog,
      def: {
        name: "read_skill_file",
        description: "read",
        parameters: { type: "object" },
        annotations: { effect: "read" as const },
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: call private
    const result = await (plugin as any).dispatchSkillTool(entry, {
      skill: "pdf",
      path: "reference.md",
    });

    expect(result).toBe("the reference");
    expect(h.read).toHaveBeenCalledWith(h.client, `${VOL}/pdf/reference.md`);
  });
});
