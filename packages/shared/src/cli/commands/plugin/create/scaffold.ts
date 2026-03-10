import fs from "node:fs";
import path from "node:path";
import { humanizeResourceType, MANIFEST_SCHEMA_ID } from "./resource-defaults";
import type { CreateAnswers } from "./types";

/** Convert kebab-name to PascalCase (e.g. my-plugin -> MyPlugin). */
function toPascalCase(name: string): string {
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("");
}

/** Convert kebab-name to camelCase (e.g. my-plugin -> myPlugin). */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Build manifest.json resources from selected resources. */
function buildManifestResources(answers: CreateAnswers) {
  const required: unknown[] = [];
  const optional: unknown[] = [];

  for (const r of answers.resources) {
    const alias = humanizeResourceType(r.type);
    const entry = {
      type: r.type,
      alias,
      resourceKey: r.resourceKey,
      description: r.description || `Required for ${alias} functionality.`,
      permission: r.permission,
      fields: r.fields,
    };
    if (r.required) {
      required.push(entry);
    } else {
      optional.push(entry);
    }
  }

  return { required, optional };
}

/** Build full manifest object for manifest.json. */
function buildManifest(answers: CreateAnswers): Record<string, unknown> {
  const { required, optional } = buildManifestResources(answers);
  const manifest: Record<string, unknown> = {
    $schema: MANIFEST_SCHEMA_ID,
    name: answers.name,
    displayName: answers.displayName,
    description: answers.description,
    resources: { required, optional },
  };
  if (answers.author) manifest.author = answers.author;
  manifest.version = answers.version || "0.1.0";
  if (answers.license) manifest.license = answers.license;
  return manifest;
}

/** Resolve absolute target directory from cwd and answers. */
export function resolveTargetDir(cwd: string, answers: CreateAnswers): string {
  return path.resolve(cwd, answers.targetPath);
}

/** Track files written during scaffolding for rollback on failure. */
function writeTracked(
  filePath: string,
  content: string,
  written: string[],
): void {
  fs.writeFileSync(filePath, content);
  written.push(filePath);
}

/** Remove files written during a failed scaffold attempt. */
function rollback(written: string[], targetDir: string): void {
  for (const filePath of written.reverse()) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
  }
  try {
    const remaining = fs.readdirSync(targetDir);
    if (remaining.length === 0) fs.rmdirSync(targetDir);
  } catch {
    // directory may not be empty or may have been removed already
  }
}

/**
 * Scaffold plugin files into targetDir. Pure: no interactive I/O.
 * Writes manifest.json, {name}.ts, index.ts; for isolated also package.json, tsconfig.json, README.md.
 * On failure, rolls back any files already written.
 */
export function scaffoldPlugin(
  targetDir: string,
  answers: CreateAnswers,
  options: { isolated: boolean },
): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];

  try {
    const manifest = buildManifest(answers);
    const className = toPascalCase(answers.name);
    const exportName = toCamelCase(answers.name);

    writeTracked(
      path.join(targetDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      written,
    );

    const pluginTs = `import {
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import manifest from "./manifest.json";

export class ${className} extends Plugin {
  static manifest = manifest as PluginManifest<"${answers.name}">;

  injectRoutes(router: IAppRouter): void {
    // Add your routes here, e.g.:
    // this.route(router, {
    //   name: "example",
    //   method: "get",
    //   path: "/",
    //   handler: async (_req, res) => {
    //     res.json({ message: "Hello from ${answers.name}" });
    //   },
    // });
  }
}

export const ${exportName} = toPlugin(${className});
`;

    writeTracked(path.join(targetDir, `${answers.name}.ts`), pluginTs, written);

    const indexTs = `export { ${className}, ${exportName} } from "./${answers.name}";
`;

    writeTracked(path.join(targetDir, "index.ts"), indexTs, written);

    if (options.isolated) {
      const packageName =
        answers.name.includes("/") || answers.name.startsWith("@")
          ? answers.name
          : `appkit-plugin-${answers.name}`;

      const packageJson = {
        name: packageName,
        version: answers.version || "0.1.0",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        files: ["dist"],
        scripts: {
          build: "tsc",
          typecheck: "tsc --noEmit",
        },
        peerDependencies: {
          "@databricks/appkit": ">=0.5.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
        },
      };

      writeTracked(
        path.join(targetDir, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`,
        written,
      );

      const tsconfigJson = {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: ".",
          declaration: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["*.ts"],
        exclude: ["node_modules", "dist"],
      };

      writeTracked(
        path.join(targetDir, "tsconfig.json"),
        `${JSON.stringify(tsconfigJson, null, 2)}\n`,
        written,
      );

      const readme = `# ${answers.displayName}

${answers.description}

## Installation

\`\`\`bash
pnpm add ${packageName} @databricks/appkit
\`\`\`

## Usage

Register the plugin in your AppKit app:

\`\`\`ts
import { createApp } from "@databricks/appkit";
import { ${exportName} } from "${packageName}";

createApp({
  plugins: [
    ${exportName}(),
    // ... other plugins
  ],
}).then((app) => { /* ... */ });
\`\`\`
`;

      writeTracked(path.join(targetDir, "README.md"), readme, written);
    }
  } catch (err) {
    rollback(written, targetDir);
    throw err;
  }
}
