import fs from "node:fs/promises";
import path from "node:path";

/** Read cap for a bundled skill resource file (bytes). */
const MAX_SKILL_FILE_BYTES = 1_000_000;

/**
 * Reads a bundled skill resource file from local disk, constrained to the
 * skill's own directory. The path must be relative; `..` traversal, null
 * bytes, and absolute paths are rejected, and the resolved path is verified
 * to stay within `baseDir` (a containment guard the agent markdown loader
 * does not itself apply). Throws when the target is missing, not a file, or
 * exceeds the size cap.
 */
export async function readSkillResource(
  baseDir: string,
  relPath: string,
  maxSize = MAX_SKILL_FILE_BYTES,
): Promise<string> {
  if (relPath.includes("\0")) {
    throw new Error("Path must not contain null bytes.");
  }
  if (relPath.length > 4096) {
    throw new Error("Path exceeds the maximum length of 4096 characters.");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(
      "Skill resource path must be relative to the skill directory.",
    );
  }
  if (relPath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error('Path traversal ("../") is not allowed.');
  }

  const root = path.resolve(baseDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Resolved path escapes the skill directory.");
  }

  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new Error(`Skill resource '${relPath}' is not a file.`);
  }
  if (stat.size > maxSize) {
    throw new Error(
      `Skill resource '${relPath}' exceeds the ${maxSize}-byte read limit.`,
    );
  }

  return fs.readFile(abs, "utf-8");
}
