/**
 * Replaces all generated HTML pages with redirect pages pointing to developers.databricks.com.
 * Run AFTER `docusaurus build` so that llms.txt and .md files are generated
 * from the original HTML content first.
 *
 * Static files (schemas, llms.txt, .md) are left untouched.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "../build");
const DOCS_BASE = "https://developers.databricks.com/docs/appkit/v0";

function generateRedirectHtml(targetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Redirecting&hellip;</title>
  <link rel="canonical" href="${targetUrl}" />
  <meta http-equiv="refresh" content="0; url=${targetUrl}" />
</head>
<body>
  <p>This page has moved. Redirecting to <a href="${targetUrl}">${targetUrl}</a>&hellip;</p>
</body>
</html>`;
}

function findHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...findHtmlFiles(fullPath));
    } else if (entry === "index.html") {
      results.push(fullPath);
    }
  }
  return results;
}

if (!existsSync(BUILD_DIR)) {
  console.error(`Build directory not found: ${BUILD_DIR}`);
  console.error("Run 'docusaurus build' first.");
  process.exit(1);
}

console.log("Applying developers.databricks.com redirects to HTML pages...");

const htmlFiles = findHtmlFiles(BUILD_DIR);
let count = 0;

for (const htmlPath of htmlFiles) {
  // Get path relative to build dir, e.g. "/docs/plugins/lakebase"
  const relativePath = htmlPath
    .slice(BUILD_DIR.length)
    .replace(/\/index\.html$/, "");

  // Map /docs/{path} → /{path} (the target base already includes /docs/appkit/v0,
  // so strip the local docusaurus /docs/ route prefix before appending)
  const pathWithoutDocs = relativePath.replace(/^\/docs\/?/, "/");
  const targetUrl = `${DOCS_BASE}${pathWithoutDocs || "/"}`;

  writeFileSync(htmlPath, generateRedirectHtml(targetUrl));
  count++;
}

// Catch-all 404.html for paths not matching a generated route
const notFoundHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Redirecting&hellip;</title>
  <script>
    (function() {
      var path = window.location.pathname.replace(/^\\/appkit\\/?/, '/');
      path = path.replace(/^\\/docs\\/?/, '/');
      var target = "${DOCS_BASE}" + path + window.location.search + window.location.hash;
      window.location.replace(target);
    })();
  </script>
</head>
<body>
  <p>Redirecting to <a href="${DOCS_BASE}/">AppKit Documentation</a>&hellip;</p>
</body>
</html>`;
writeFileSync(join(BUILD_DIR, "404.html"), notFoundHtml);

console.log(`Done! Replaced ${count} HTML page(s) with redirects.`);
