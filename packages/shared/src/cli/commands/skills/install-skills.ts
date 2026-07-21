import fs from "node:fs";
import path from "node:path";

/**
 * The installed AppKit package that ships the `skills/` directory. Skills are
 * shipped inside `@databricks/appkit` (see `files` in its package.json and
 * `tools/dist-appkit.ts`), so we resolve them from the consumer's node_modules.
 */
const SKILLS_PACKAGE = "@databricks/appkit";

/** Where slash-command markdown lives in the consumer project. */
const COMMANDS_SUBDIR = path.join(".claude", "commands");

export interface InstallSkillsOptions {
  /** Target project directory. Defaults to process.cwd(). */
  dir?: string;
  /** Copy the files instead of symlinking (portable across git/deploy). */
  copy?: boolean;
  /** Overwrite an existing entry even if it isn't ours. */
  force?: boolean;
}

export interface InstalledSkill {
  name: string;
  source: string;
  target: string;
  action: "linked" | "copied" | "skipped" | "replaced";
  reason?: string;
}

export interface InstallSkillsResult {
  skillsDir: string;
  commandsDir: string;
  installed: InstalledSkill[];
}

/**
 * Locate the shipped `skills/` directory inside the installed AppKit package.
 * In a consuming project this is `node_modules/@databricks/appkit/skills`; in
 * the monorepo that path is a workspace symlink to `packages/appkit`, which now
 * carries `skills/`, so the same resolution works in both places.
 */
export function findSkillsDir(targetDir: string): string | null {
  const skillsDir = path.join(
    targetDir,
    "node_modules",
    SKILLS_PACKAGE,
    "skills",
  );
  return fs.existsSync(skillsDir) ? skillsDir : null;
}

/**
 * Whether an existing target path was created by us (a symlink into the
 * package's skills dir, or a copy we can safely replace). We only auto-replace
 * symlinks pointing at the package; regular files are left alone unless forced.
 */
function existingIsOurs(target: string, source: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(
        path.dirname(target),
        fs.readlinkSync(target),
      );
      return resolved === path.resolve(source);
    }
  } catch {
    // no existing target
  }
  return false;
}

/**
 * Install AppKit's shipped skills as slash commands in the consumer project's
 * `.claude/commands/`. Symlinks by default (so upgrades to the package flow
 * through automatically); pass `copy` for environments where symlinks don't
 * survive (git checkouts, Databricks Apps deploy).
 */
export function installSkills(
  options: InstallSkillsOptions = {},
): InstallSkillsResult {
  const targetDir = options.dir ? path.resolve(options.dir) : process.cwd();

  const skillsDir = findSkillsDir(targetDir);
  if (!skillsDir) {
    throw new Error(
      `Could not find ${SKILLS_PACKAGE}/skills in ${targetDir}. ` +
        `Install ${SKILLS_PACKAGE} first (e.g. npm install ${SKILLS_PACKAGE}).`,
    );
  }

  const commandsDir = path.join(targetDir, COMMANDS_SUBDIR);
  fs.mkdirSync(commandsDir, { recursive: true });

  const files = fs
    .readdirSync(skillsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const installed: InstalledSkill[] = [];

  for (const file of files) {
    const source = path.join(skillsDir, file);
    const target = path.join(commandsDir, file);
    const name = path.basename(file, ".md");

    // lstat (not existsSync) so a dangling symlink still counts as present.
    let hasEntry: boolean;
    try {
      fs.lstatSync(target);
      hasEntry = true;
    } catch {
      hasEntry = false;
    }

    const ours = existingIsOurs(target, source);

    if (hasEntry && !ours && !options.force) {
      installed.push({
        name,
        source,
        target,
        action: "skipped",
        reason: "a different file already exists (use --force to overwrite)",
      });
      continue;
    }

    const replacing = hasEntry;
    if (replacing) {
      fs.rmSync(target, { force: true });
    }

    if (options.copy) {
      fs.copyFileSync(source, target);
      installed.push({
        name,
        source,
        target,
        action: replacing ? "replaced" : "copied",
      });
    } else {
      // Relative link so the .claude dir stays portable if the project moves.
      const linkTarget = path.relative(commandsDir, source);
      fs.symlinkSync(linkTarget, target);
      installed.push({
        name,
        source,
        target,
        action: replacing ? "replaced" : "linked",
      });
    }
  }

  return { skillsDir, commandsDir, installed };
}
