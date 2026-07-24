/**
 * Upserts a sticky PR comment with a self-contained command to scaffold a new
 * app from this PR's template artifact.
 *
 * Invoked via `actions/github-script`. The comment body is read from the file
 * at COMMENT_PATH (built by the workflow step so the run id, artifact name, and
 * output dir are interpolated from CI context). The body carries the marker
 * below as its first line, which we reuse to find and update an existing
 * comment instead of posting a new one on every run.
 */

const fs = require("node:fs");

const MARKER = "<!-- pr-template-artifact -->";

module.exports = async ({ github, context }) => {
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;
  const body = fs.readFileSync(process.env.COMMENT_PATH, "utf-8");

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(MARKER));

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
