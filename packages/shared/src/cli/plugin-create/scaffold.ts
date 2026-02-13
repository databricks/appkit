import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PERMISSION_BY_TYPE,
  getDefaultFieldsForType,
  humanizeResourceType,
  MANIFEST_SCHEMA_ID,
  resourceKeyFromType,
} from "./resource-defaults.js";
import type { CreateAnswers } from "./types.js";

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
    const permission = DEFAULT_PERMISSION_BY_TYPE[r.type] ?? "CAN_VIEW";
    const fields = getDefaultFieldsForType(r.type);
    const alias = humanizeResourceType(r.type);
    const resourceKey = resourceKeyFromType(r.type);
    const entry = {
      type: r.type,
      alias,
      resourceKey,
      description: r.description || `Required for ${alias} functionality.`,
      permission,
      fields,
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
  if (answers.version) manifest.version = answers.version;
  if (answers.license) manifest.license = answers.license;
  return manifest;
}

/** Resolve absolute target directory from cwd and answers. */
export function resolveTargetDir(cwd: string, answers: CreateAnswers): string {
  return path.resolve(cwd, answers.targetPath);
}

/**
 * Scaffold plugin files into targetDir. Pure: no interactive I/O.
 * Writes manifest.json, manifest.ts, {name}.ts, index.ts; for isolated also package.json, tsconfig.json, README.md.
 */
export function scaffoldPlugin(
  targetDir: string,
  answers: CreateAnswers,
  options: { isolated: boolean },
): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const manifest = buildManifest(answers);
  const className = toPascalCase(answers.name);
  const exportName = toCamelCase(answers.name);

  // manifest.json
  fs.writeFileSync(
    path.join(targetDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // manifest.ts
  const manifestTs = `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "@databricks/appkit";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const manifest = JSON.parse(
  readFileSync(join(__dirname, "manifest.json"), "utf-8"),
) as PluginManifest;
`;

  fs.writeFileSync(path.join(targetDir, "manifest.ts"), manifestTs);

  // Main plugin class file
  const pluginTs = `import { Plugin, toPlugin, type IAppRouter } from "@databricks/appkit";
import { manifest } from "./manifest.js";

export class ${className} extends Plugin {
  name = "${answers.name}";

  static manifest = manifest;

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

export const ${exportName} = toPlugin<
  typeof ${className},
  Record<string, never>,
  "${answers.name}"
>(${className}, "${answers.name}");
`;

  fs.writeFileSync(path.join(targetDir, `${answers.name}.ts`), pluginTs);

  // index.ts
  const indexTs = `export { ${className}, ${exportName}, manifest } from "./${answers.name}.js";
`;

  fs.writeFileSync(path.join(targetDir, "index.ts"), indexTs);

  if (options.isolated) {
    const packageName =
      answers.name.includes("/") || answers.name.startsWith("@")
        ? answers.name
        : `appkit-plugin-${answers.name}`;

    const packageJson = {
      name: packageName,
      version: answers.version || "1.0.0",
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

    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
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

    fs.writeFileSync(
      path.join(targetDir, "tsconfig.json"),
      `${JSON.stringify(tsconfigJson, null, 2)}\n`,
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

    fs.writeFileSync(path.join(targetDir, "README.md"), readme);
  }
}
