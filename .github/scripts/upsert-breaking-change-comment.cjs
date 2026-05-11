/**
 * Upserts (or removes) a sticky PR comment summarizing breaking commits
 * detected by `detect-breaking-commits.sh`.
 *
 * Invoked via `actions/github-script`. Inputs come from environment vars:
 *   FOUND          - "true" if the scan found breaking commits
 *   BREAKING_LIST  - markdown bullet list of breaking commits
 *   ALLOWED        - "true" if the PR carries the allow-breaking-change label
 */

const MARKER = "<!-- pr-breaking-change-check -->";

module.exports = async ({ github, context }) => {
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;
  const found = process.env.FOUND === "true";
  const allowed = process.env.ALLOWED === "true";
  const list = process.env.BREAKING_LIST || "";

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(MARKER));

  if (!found) {
    if (existing) {
      await github.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: existing.id,
      });
    }
    return;
  }

  const status = allowed
    ? "> This PR has the `allow-breaking-change` label, so this check will pass. Make sure the next release is intentionally bumped to a major version."
    : "> Add the **`allow-breaking-change`** label to this PR if the breaking change is intentional, or rewrite the offending commits to remove the `!` / `BREAKING CHANGE:` footer.";

  const body = [
    MARKER,
    "### Breaking change detected",
    "",
    "This PR contains Conventional Commits breaking-change markers (`type!:` or `BREAKING CHANGE:` footer) in one or more of the following surfaces, all of which feed `release-it` after a squash merge:",
    "",
    list.trim(),
    "",
    "Merging this PR will force a **major** version bump on the next release (`bumpStrict: true` in `.release-it.json`).",
    "",
    status,
  ].join("\n");

  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    });
  }
};
