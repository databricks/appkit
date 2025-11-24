import fs from "node:fs";
import path from "node:path";

export function writeBrowserStub(outDir: string) {
  fs.writeFileSync(
    path.join(outDir, "browser-stub.d.ts"),
    `export const _error: never;
/**
 * ❌ @databricks/apps (Node SDK) cannot be imported in a browser/React app.
 * Please import from \`@databricks/app-kit/react\` instead.
 */
`,
    "utf-8",
  );

  fs.writeFileSync(
    path.join(outDir, "browser-stub.js"),
    `throw new Error(
  "❌ @databricks/app-kit (Node SDK) cannot be imported in a browser. Use @databricks/app-kit/react instead."
);`,
    "utf-8",
  );
}
