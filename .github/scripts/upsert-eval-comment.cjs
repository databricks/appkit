/**
 * Upserts a sticky "Eval running" comment on a PR after the dogfood eval
 * pipeline has been launched.
 *
 * Invoked via `actions/github-script`. Inputs come from environment vars:
 *   PR_NUMBER - the pull request number
 *   HEAD_SHA  - the commit the eval was launched for
 *   RUN_JSON  - raw JSON from `databricks jobs run-now` (used to link the run)
 */

const MARKER = "<!-- pr-eval-run -->";
const EVALS_MONITOR_URL =
  "https://evals-monitor-6051921418418893.staging.aws.databricksapps.com";
const DATABRICKS_HOST = "https://dogfood.staging.databricks.com";
const JOB_ID = "398185277057549";
const WORKSPACE_ID = "6051921418418893";

module.exports = async ({ github, context }) => {
  const { owner, repo } = context.repo;
  const issue_number = Number(process.env.PR_NUMBER);
  const shortSha = (process.env.HEAD_SHA || "").substring(0, 7);

  // run_id comes back in the run-now response, so the run link costs no extra call.
  let runId;
  try {
    runId = JSON.parse(process.env.RUN_JSON || "{}").run_id;
  } catch {
    runId = undefined;
  }

  const links = [
    `[View results in evals-monitor →](${EVALS_MONITOR_URL}/prs/appkit/${issue_number})`,
  ];
  if (runId) {
    links.push(
      `<sub>[job run ↗](${DATABRICKS_HOST}/jobs/${JOB_ID}/runs/${runId}?o=${WORKSPACE_ID})</sub>`,
    );
  }

  const body = [
    MARKER,
    "### ⏳ Eval running",
    "",
    `Eval pipeline launched for commit \`${shortSha}\`.`,
    "",
    links.join(" · "),
  ].join("\n");

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
