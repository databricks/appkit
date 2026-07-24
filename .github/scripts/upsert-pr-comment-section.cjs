/**
 * Upserts one section of the shared "PR bot" sticky comment.
 *
 * Multiple workflows contribute sections to a single comment marked with
 * MARKER (currently: the evals-monitor link and the try-this-template command).
 * Each caller owns one SECTION_ID and rewrites only its delimited block, so the
 * workflows preserve each other's content instead of clobbering it — a plain
 * push reruns the template job without wiping the eval link, and vice versa.
 * Sections are always re-rendered in SECTION_ORDER for a stable layout
 * regardless of which workflow writes first.
 *
 * This is a read-modify-write on one comment. The two current callers are
 * separated in time (eval link posts on PR open; the template command posts
 * after the ~5-min build), so concurrent writes are effectively impossible.
 * Adding a section that races the others would need real conflict handling.
 *
 * Invoked via `actions/github-script`. Env:
 *   SECTION_ID   - which section this caller owns (must be in SECTION_ORDER)
 *   SECTION_PATH - file containing the section's markdown body
 */

const fs = require("node:fs");

const MARKER = "<!-- pr-bot -->";
// Canonical top-to-bottom order of sections in the unified comment.
const SECTION_ORDER = ["evals", "template"];

const openTag = (id) => `<!-- section:${id} -->`;
const closeTag = (id) => `<!-- /section:${id} -->`;

function parseSections(body) {
  const out = {};
  for (const id of SECTION_ORDER) {
    const start = body.indexOf(openTag(id));
    const end = body.indexOf(closeTag(id));
    if (start !== -1 && end !== -1 && end > start) {
      out[id] = body.slice(start + openTag(id).length, end).trim();
    }
  }
  return out;
}

function render(sections) {
  const parts = [MARKER];
  for (const id of SECTION_ORDER) {
    if (sections[id] == null) continue;
    parts.push(`${openTag(id)}\n${sections[id]}\n${closeTag(id)}`);
  }
  return parts.join("\n\n");
}

module.exports = async ({ github, context }) => {
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  const id = process.env.SECTION_ID;
  if (!SECTION_ORDER.includes(id)) {
    throw new Error(
      `Unknown SECTION_ID "${id}"; expected one of ${SECTION_ORDER.join(", ")}`,
    );
  }
  const sectionBody = fs.readFileSync(process.env.SECTION_PATH, "utf-8").trim();

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(MARKER));

  const sections = existing ? parseSections(existing.body) : {};
  sections[id] = sectionBody;
  const body = render(sections);

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
