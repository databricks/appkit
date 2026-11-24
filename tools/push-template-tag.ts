import { spawnSync } from "node:child_process";

/**
 * Commits the synced template files, tags the commit template-v<version> and
 * pushes both. The tag stays on the code the release was cut from; if the
 * branch moved meanwhile, only the branch gets the sync replayed on top.
 */
export function pushTemplateTag(
  version: string,
  files: string[],
  cwd: string,
): boolean {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd, stdio: "inherit" }).status === 0;
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf-8",
  }).stdout.trim();
  const tag = `template-v${version}`;
  return (
    git("add", ...files) &&
    git(
      "commit",
      "-s",
      "-m",
      `chore: sync template to v${version} [skip ci]`,
    ) &&
    // Tag before the pull: commits merged after the release never went
    // through the release pipeline, so they must not ship in the template.
    git("tag", "-a", tag, "-m", `Template v${version}`) &&
    // The branch may have moved while we waited for the registry.
    git("pull", "--rebase", "origin", branch) &&
    // --atomic: never leave the tag pushed without the branch (or the reverse).
    git("push", "--atomic", "origin", "HEAD", `refs/tags/${tag}`)
  );
}
