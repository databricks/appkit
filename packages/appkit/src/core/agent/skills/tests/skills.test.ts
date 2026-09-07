import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { loadSkillsFromDir } from "../load-skills";
import { parseSkill } from "../parse-skill";
import { readSkillResource } from "../read-resource";
import { renderLoadedSkill, renderSkillCatalog } from "../render";
import { resolveSkill, resolveSkillCatalog } from "../resolve-catalog";
import type { SkillDefinition, SkillSource } from "../types";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes `<workDir>/<name>/SKILL.md` plus optional sibling resource files. */
function writeSkill(
  name: string,
  content: string,
  files: Record<string, string> = {},
) {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf-8");
  }
  return dir;
}

/** Convenience for resolver tests that don't need real files. */
function skill(
  name: string,
  source: SkillSource,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    body: `${name} body`,
    source,
    dir: `/fake/${source}/${name}`,
    files: [],
    ...overrides,
  };
}

describe("parseSkill", () => {
  test("parses name, description, and body", () => {
    const parsed = parseSkill(
      "---\nname: pdf\ndescription: Work with PDFs\n---\nHow to work with PDFs.",
      "SKILL.md",
    );
    expect(parsed).toMatchObject({
      name: "pdf",
      description: "Work with PDFs",
      body: "How to work with PDFs.",
    });
    expect(parsed.allowedTools).toBeUndefined();
  });

  test("accepts allowed-tools as an array or comma string", () => {
    const arr = parseSkill(
      "---\nname: a\ndescription: d\nallowed-tools:\n  - read\n  - grep\n---\nbody",
      "SKILL.md",
    );
    expect(arr.allowedTools).toEqual(["read", "grep"]);

    const str = parseSkill(
      "---\nname: b\ndescription: d\nallowed-tools: read, grep\n---\nbody",
      "SKILL.md",
    );
    expect(str.allowedTools).toEqual(["read", "grep"]);
  });

  test("throws when name or description is missing", () => {
    expect(() =>
      parseSkill("---\ndescription: d\n---\nbody", "SKILL.md"),
    ).toThrow(/missing a non-empty 'name'/);
    expect(() => parseSkill("---\nname: a\n---\nbody", "SKILL.md")).toThrow(
      /missing a non-empty 'description'/,
    );
  });

  test("rejects a name that breaks addressing", () => {
    expect(() =>
      parseSkill("---\nname: bad:name\ndescription: d\n---\nbody", "SKILL.md"),
    ).toThrow(/invalid name/);
  });

  test("throws when frontmatter is absent", () => {
    expect(() => parseSkill("no frontmatter here", "SKILL.md")).toThrow(
      /no YAML frontmatter/,
    );
  });

  test("warns on unknown frontmatter keys, keeps parsing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseSkill(
      "---\nname: a\ndescription: d\nbananas: 3\n---\nbody",
      "SKILL.md",
    );
    expect(parsed.name).toBe("a");
    expect(warn).toHaveBeenCalled();
  });
});

describe("loadSkillsFromDir", () => {
  test("returns [] for a missing directory", async () => {
    const skills = await loadSkillsFromDir(
      path.join(workDir, "nope"),
      "bundle-global",
    );
    expect(skills).toEqual([]);
  });

  test("discovers skills and enumerates resource files recursively", async () => {
    writeSkill("pdf", "---\nname: pdf\ndescription: d\n---\nbody", {
      "reference.md": "ref",
      "scripts/extract.py": "print(1)",
    });
    const skills = await loadSkillsFromDir(workDir, "bundle-global");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "pdf",
      description: "d",
      body: "body",
      source: "bundle-global",
    });
    expect(skills[0].files).toEqual(["reference.md", "scripts/extract.py"]);
  });

  test("skips folders without a SKILL.md", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.mkdirSync(path.join(workDir, "not-a-skill"), { recursive: true });
    writeSkill("real", "---\nname: real\ndescription: d\n---\nbody");
    const skills = await loadSkillsFromDir(workDir, "bundle-global");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("resolveSkillCatalog", () => {
  test("per-agent skills are auto-visible; global skills are opt-in", () => {
    const local = skill("local", "bundle-agent");
    const g1 = skill("wanted", "bundle-global");
    const g2 = skill("unwanted", "bundle-global");

    const catalog = resolveSkillCatalog({
      agentName: "a",
      agentSkillNames: ["wanted"],
      perAgentSkills: [local],
      globalSkills: [g1, g2],
      autoInherit: false,
    });

    expect([...catalog.byAddress.keys()].sort()).toEqual(["local", "wanted"]);
    expect(catalog.catalog.map((e) => e.name).sort()).toEqual([
      "local",
      "wanted",
    ]);
  });

  test("autoInherit exposes every global skill without an opt-in list", () => {
    const catalog = resolveSkillCatalog({
      agentName: "a",
      perAgentSkills: [],
      globalSkills: [skill("x", "bundle-global"), skill("y", "bundle-global")],
      autoInherit: true,
    });
    expect([...catalog.byAddress.keys()].sort()).toEqual(["x", "y"]);
  });

  test("warns for opt-in names that match no skill", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveSkillCatalog({
      agentName: "a",
      agentSkillNames: ["ghost"],
      perAgentSkills: [],
      globalSkills: [skill("real", "bundle-global")],
      autoInherit: false,
    });
    expect(warn).toHaveBeenCalled();
  });

  test("cross-source name collision produces qualified names + ambiguous bare", () => {
    const catalog = resolveSkillCatalog({
      agentName: "a",
      perAgentSkills: [skill("dup", "bundle-agent")],
      globalSkills: [skill("dup", "bundle-global"), skill("dup", "volume")],
      autoInherit: true,
    });
    expect([...catalog.byAddress.keys()].sort()).toEqual([
      "agent:dup",
      "bundle:dup",
      "volume:dup",
    ]);
    expect(catalog.ambiguous.get("dup")).toEqual([
      "agent:dup",
      "bundle:dup",
      "volume:dup",
    ]);
  });

  test("throws when two skills from the same source share a name", () => {
    expect(() =>
      resolveSkillCatalog({
        agentName: "a",
        perAgentSkills: [],
        globalSkills: [
          skill("dup", "bundle-global", { dir: "/a" }),
          skill("dup", "bundle-global", { dir: "/b" }),
        ],
        autoInherit: true,
      }),
    ).toThrow(/unique within a source/);
  });
});

describe("resolveSkill", () => {
  const catalog = resolveSkillCatalog({
    agentName: "a",
    perAgentSkills: [skill("solo", "bundle-agent")],
    globalSkills: [skill("dup", "bundle-global"), skill("dup", "volume")],
    autoInherit: true,
  });

  test("resolves a bare unique name", () => {
    expect(resolveSkill(catalog, "solo").name).toBe("solo");
  });

  test("resolves a qualified name", () => {
    expect(resolveSkill(catalog, "volume:dup").source).toBe("volume");
  });

  test("errors on an ambiguous bare name, listing alternatives", () => {
    expect(() => resolveSkill(catalog, "dup")).toThrow(
      /ambiguous.*bundle:dup.*volume:dup/,
    );
  });

  test("errors on an unknown name", () => {
    expect(() => resolveSkill(catalog, "missing")).toThrow(/Unknown skill/);
  });
});

describe("renderSkillCatalog", () => {
  test("lists each entry and points at load_skill", () => {
    const out = renderSkillCatalog([
      { name: "pdf", description: "Work with PDFs" },
      { name: "sql", description: "Write SQL" },
    ]);
    expect(out).toContain("load_skill");
    expect(out).toContain("**pdf**: Work with PDFs");
    expect(out).toContain("**sql**: Write SQL");
  });
});

describe("renderLoadedSkill", () => {
  test("includes the body and a file manifest when present", () => {
    const out = renderLoadedSkill(
      skill("pdf", "bundle-global", {
        body: "Detailed PDF instructions.",
        files: ["reference.md", "scripts/x.py"],
        allowedTools: ["read", "grep"],
      }),
    );
    expect(out).toContain("Detailed PDF instructions.");
    expect(out).toContain("read_skill_file");
    expect(out).toContain("- reference.md");
    expect(out).toContain("- scripts/x.py");
    expect(out).toContain("Suggested tools for this skill: read, grep");
  });

  test("omits the manifest when there are no bundled files", () => {
    const out = renderLoadedSkill(
      skill("bare", "bundle-agent", { body: "Just prose.", files: [] }),
    );
    expect(out).toContain("Just prose.");
    expect(out).not.toContain("Bundled files");
  });
});

describe("readSkillResource", () => {
  test("reads a file inside the skill directory", async () => {
    const dir = writeSkill("pdf", "---\nname: pdf\ndescription: d\n---\nbody", {
      "reference.md": "the reference",
    });
    await expect(readSkillResource(dir, "reference.md")).resolves.toBe(
      "the reference",
    );
  });

  test("rejects traversal, absolute paths, and escapes", async () => {
    const dir = writeSkill("pdf", "---\nname: pdf\ndescription: d\n---\nbody");
    // A real secret sitting next to the skill dir, reachable only via escape.
    fs.writeFileSync(path.join(workDir, "secret.txt"), "top secret", "utf-8");
    await expect(readSkillResource(dir, "../secret.txt")).rejects.toThrow(
      /traversal/,
    );
    await expect(
      readSkillResource(dir, path.join(workDir, "secret.txt")),
    ).rejects.toThrow(/relative/);
  });

  test("throws when the file is missing", async () => {
    const dir = writeSkill("pdf", "---\nname: pdf\ndescription: d\n---\nbody");
    await expect(readSkillResource(dir, "nope.md")).rejects.toThrow();
  });

  test("enforces the size cap", async () => {
    const dir = writeSkill("pdf", "---\nname: pdf\ndescription: d\n---\nbody", {
      "big.txt": "x".repeat(50),
    });
    await expect(readSkillResource(dir, "big.txt", 10)).rejects.toThrow(
      /read limit/,
    );
  });
});
