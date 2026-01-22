import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as docgen from "react-docgen-typescript";

type ComponentDoc = docgen.ComponentDoc;

const GITHUB_REPO_URL = "https://github.com/databricks/appkit/blob/main";
const COMPONENTS_EXAMPLES_DIR = "packages/appkit-ui/src/react/ui/examples";
const COMPONENTS_DIR = "packages/appkit-ui/src/react/ui";
const CHARTS_DIR = "packages/appkit-ui/src/react/charts";
const TABLE_DIR = "packages/appkit-ui/src/react/table";
const DOCS_OUTPUT_DIR = "docs/docs/api/appkit-ui";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const parser = docgen.withCustomConfig(
  path.join(repoRoot, "packages/appkit-ui/tsconfig.json"),
  {
    savePropValueAsString: true,
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    propFilter: (prop) => {
      if (prop.parent) {
        return !prop.parent.fileName.includes("@types/react");
      }
      return true;
    },
  },
);

function toGithubPath(component: ComponentDoc): string {
  const filePath = component.filePath || "";
  return path.relative(repoRoot, filePath);
}

function sanitizeDescriptionText(text: string): string {
  // Extract only the first paragraph (before first blank line)
  const firstParagraph = text.split(/\n\s*\n/)[0];

  return firstParagraph
    .replace(/\{@link\s+([^}]+)\}/g, "$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\s+/g, " ") // Collapse whitespace within the paragraph
    .trim();
}

function sanitizeDescriptionFull(text: string): string {
  // Basic sanitization only - preserve original formatting
  return text
    .replace(/\{@link\s+([^}]+)\}/g, "$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
  // No whitespace collapsing - JSDoc already has proper formatting!
}

function buildPropsSection(
  props: ComponentDoc["props"],
  headingLevel = 2,
): string {
  const entries = Object.entries(props);
  const headingPrefix = "#".repeat(headingLevel);

  if (entries.length === 0) {
    return `
${headingPrefix} Props

This component extends standard HTML element attributes.
`;
  }

  const rows = entries
    .map(([name, prop]) => {
      const typeStr = prop.type.name.replace(/\|/g, "\\|");
      const required = prop.required ? "✓" : "";
      const defaultVal = prop.defaultValue?.value
        ? `\`${prop.defaultValue.value}\``
        : "-";
      const desc = prop.description
        ? sanitizeDescriptionText(prop.description)
        : "-";
      return `| \`${name}\` | \`${typeStr}\` | ${required} | ${defaultVal} | ${desc} |`;
    })
    .join("\n");

  return `
${headingPrefix} Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
${rows}
`;
}

function buildUsageSection(displayName: string, headingLevel = 2): string {
  const headingPrefix = "#".repeat(headingLevel);
  // Strip "Doc" suffix from display name for usage examples
  const actualName = displayName.endsWith("Doc")
    ? displayName.slice(0, -3)
    : displayName;
  return `
${headingPrefix} Usage

\`\`\`tsx
import { ${actualName} } from '@databricks/appkit-ui';

<${actualName} /* props */ />
\`\`\`
`;
}

function buildComponentDetails(
  component: ComponentDoc,
  opts?: { propsHeadingLevel?: number; usageHeadingLevel?: number },
): string {
  const description = component.description
    ? sanitizeDescriptionFull(component.description)
    : "";
  const relativePath = toGithubPath(component);
  const propsSection = buildPropsSection(
    component.props,
    opts?.propsHeadingLevel,
  );
  const usageSection = buildUsageSection(
    component.displayName || "Component",
    opts?.usageHeadingLevel,
  );

  return `${description ? `${description}\n\n` : ""}
**Source:** [\`${relativePath}\`](${GITHUB_REPO_URL}/${relativePath})

${propsSection}

${usageSection}`;
}

interface ExampleInfo {
  name: string;
  path: string;
}

function buildExampleInfo(component: ComponentDoc): ExampleInfo | undefined {
  const filePath = component.filePath;
  if (!filePath) {
    return undefined;
  }
  const baseName = path.basename(filePath, path.extname(filePath));

  // Check UI examples directory
  let examplePath = path.join(
    repoRoot,
    COMPONENTS_EXAMPLES_DIR,
    `${baseName}.example.tsx`,
  );
  if (fs.existsSync(examplePath)) {
    return {
      name: baseName,
      path: examplePath,
    };
  }

  // Check if this is a chart component (in charts/{name}/index.tsx)
  const relativePath = path.relative(repoRoot, filePath);
  const chartsMatch = relativePath.match(/charts\/([^/]+)\/index\.tsx$/);
  if (chartsMatch) {
    const chartDir = chartsMatch[1];

    // For chart components, try to match by display name (e.g., "DonutChart" -> "donut")
    const displayName = component.displayName || "";
    const componentBaseName = displayName.endsWith("Doc")
      ? displayName.slice(0, -3)
      : displayName;
    const exampleName = componentBaseName.replace(/Chart$/, "").toLowerCase();

    // Try component-specific example first (e.g., donut.example.tsx)
    examplePath = path.join(
      repoRoot,
      CHARTS_DIR,
      chartDir,
      "examples",
      `${exampleName}.example.tsx`,
    );
    if (fs.existsSync(examplePath)) {
      return {
        name: exampleName,
        path: examplePath,
      };
    }

    // Fallback to directory-based example (e.g., pie.example.tsx)
    examplePath = path.join(
      repoRoot,
      CHARTS_DIR,
      chartDir,
      "examples",
      `${chartDir}.example.tsx`,
    );
    if (fs.existsSync(examplePath)) {
      return {
        name: chartDir,
        path: examplePath,
      };
    }
  }

  // Check if this is a table component
  if (relativePath.includes("table/")) {
    examplePath = path.join(
      repoRoot,
      TABLE_DIR,
      "examples",
      `${baseName}.example.tsx`,
    );
    if (fs.existsSync(examplePath)) {
      return {
        name: baseName,
        path: examplePath,
      };
    }
  }

  return undefined;
}

function generateGroupedComponentPage(
  groupName: string,
  components: ComponentDoc[],
  example?: ExampleInfo,
  subdir?: string,
): string {
  const sections = components
    .map((component) => {
      // Strip "Doc" suffix from display name in sections
      const displayName = component.displayName?.endsWith("Doc")
        ? component.displayName.slice(0, -3)
        : component.displayName;

      return `## ${displayName}

${buildComponentDetails(component, {
  propsHeadingLevel: 3,
  usageHeadingLevel: 3,
})}`;
    })
    .join("\n\n");

  // Generate example section based on component type
  let exampleSection = "";
  if (example) {
    if (subdir === "data") {
      // For data components: show code only (no interactive preview)
      const sourceCode = fs.readFileSync(example.path, "utf-8");
      exampleSection = `
## Example

\`\`\`tsx
${sourceCode}
\`\`\`

`;
    } else {
      // For UI components: show interactive preview
      exampleSection = `
## Example

import { DocExample } from "@site/src/components/DocExample";

<DocExample name="${example.name}" />

`;
    }
  }

  const pageDescription = components[0]?.description
    ? `${sanitizeDescriptionText(components[0].description)}\n\n`
    : "";

  return `# ${groupName}

${pageDescription}${exampleSection}
${sections}
`;
}

function findTsxFiles(dir: string) {
  const files: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTsxFiles(fullPath)); // FIX: Collect recursive results
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      files.push(fullPath);
    }
  }

  return files;
}

function findExampleFiles(
  dir: string,
): Array<{ file: string; fullPath: string }> {
  const results: Array<{ file: string; fullPath: string }> = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findExampleFiles(fullPath));
    } else if (entry.name.endsWith(".example.tsx")) {
      results.push({ file: entry.name, fullPath });
    }
  }

  return results;
}

function generateExamplesRegistry() {
  const outputPath = path.join(
    repoRoot,
    "docs/src/components/DocExample/examples.gen.ts",
  );

  // Collect examples from all directories
  const uiExamplesDir = path.join(repoRoot, COMPONENTS_EXAMPLES_DIR);
  const chartsDir = path.join(repoRoot, CHARTS_DIR);
  const tableDir = path.join(repoRoot, TABLE_DIR);

  const uiExamples = findExampleFiles(uiExamplesDir);
  const chartExamples = findExampleFiles(chartsDir);
  const tableExamples = findExampleFiles(tableDir);

  const allExamples = [...uiExamples, ...chartExamples, ...tableExamples];
  allExamples.sort((a, b) => a.file.localeCompare(b.file));

  // Generate import statements
  const imports = allExamples
    .map(({ file, fullPath }) => {
      const baseName = path.basename(file, ".example.tsx");
      const componentName = baseName
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
      const importName = `${componentName}Example`;
      const relativePath = path.relative(
        path.join(repoRoot, "docs/src/components/DocExample"),
        fullPath.replace(".tsx", ""),
      );
      return `import ${importName} from "${relativePath}";`;
    })
    .join("\n");

  // Read example source code
  const exampleEntries = allExamples.map(({ file, fullPath }) => {
    const baseName = path.basename(file, ".example.tsx");
    const componentName = baseName
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    const importName = `${componentName}Example`;
    const sourceCode = fs.readFileSync(fullPath, "utf-8");

    // Escape backticks and backslashes in source code
    const escapedSource = sourceCode
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    return `  "${baseName}": {
    Component: ${importName},
    source: \`${escapedSource}\`,
  }`;
  });

  // Generate the registry file
  const content = `/* Auto-generated by tools/generate-component-mdx.ts */
import type { ComponentType } from "react";
${imports}

export type AppKitExampleEntry = {
  Component: ComponentType;
  source: string;
};

export const examples: Record<string, AppKitExampleEntry> = {
${exampleEntries.join(",\n")}
};

export type AppKitExampleKey = keyof typeof examples;
`;

  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(
    `Generated examples registry at ${path.relative(repoRoot, outputPath)}`,
  );
}

function main() {
  const componentsDir = path.join(repoRoot, COMPONENTS_DIR);
  const chartsDir = path.join(repoRoot, CHARTS_DIR);
  const tableDir = path.join(repoRoot, TABLE_DIR);
  const outputDir = path.join(repoRoot, DOCS_OUTPUT_DIR);

  // Scan all directories
  const uiFiles = findTsxFiles(componentsDir);
  const chartFiles = findTsxFiles(chartsDir);
  const tableFiles = findTsxFiles(tableDir);

  const allFiles = [...uiFiles, ...chartFiles, ...tableFiles];
  const componentDocs = parser.parse(allFiles);

  // Generate examples registry first
  generateExamplesRegistry();

  // Filter out non-components (e.g., lifecycle methods incorrectly detected)
  const excludeList = [
    "componentDidMount",
    "componentDidUpdate",
    "componentWillUnmount",
  ];

  const validComponents = componentDocs.filter((component) => {
    const displayName = component.displayName || "";
    const filePath = component.filePath || "";

    return (
      Boolean(displayName) &&
      !excludeList.includes(displayName) &&
      !component.filePath?.includes(".example.") &&
      // For charts: only include *Doc components
      (filePath.includes("src/react/charts/")
        ? displayName.endsWith("Doc")
        : true)
    );
  });

  const sortedComponents = [...validComponents].sort((a, b) =>
    (a.displayName ?? "").localeCompare(b.displayName ?? ""),
  );
  const componentsByFile = new Map<string, ComponentDoc[]>();

  sortedComponents.forEach((component) => {
    const filePath = component.filePath || "";
    const displayName = component.displayName || "";

    // For Doc components from charts, use display name as key (separate pages)
    // For other components, group by file path
    const key =
      filePath.includes("src/react/charts/") && displayName.endsWith("Doc")
        ? displayName // Each Doc component gets its own page
        : filePath || displayName; // Other components grouped by file

    if (!componentsByFile.has(key)) {
      componentsByFile.set(key, []);
    }

    componentsByFile.get(key)?.push(component);
  });

  function getOutputSubdir(component: ComponentDoc): string {
    const filePath = component.filePath || "";
    // Data visualization components (charts + tables)
    if (
      filePath.includes("src/react/charts/") ||
      filePath.includes("src/react/table/")
    ) {
      return "data";
    }
    // All other UI components
    return "ui";
  }

  function toPageName(key: string): string {
    const components = componentsByFile.get(key);
    if (components?.[0]) {
      const displayName = components[0].displayName || "";
      // Strip "Doc" suffix from display names
      if (displayName.endsWith("Doc")) {
        return displayName.slice(0, -3);
      }
      if (displayName) {
        return displayName;
      }
    }

    // Fallback to filename-based name
    const baseName = path.basename(key, path.extname(key));
    const pascal = baseName
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((segment) => segment[0].toUpperCase() + segment.slice(1))
      .join("");
    return pascal || "Component";
  }

  const outputPageNames: string[] = [];

  // Create output directory if it doesn't exist
  fs.mkdirSync(outputDir, { recursive: true });

  // Delete only subdirectories (preserve files like index.md)
  if (fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(outputDir, entry.name), { recursive: true });
      }
    }
  }

  // Create subdirectories
  const dataOutputDir = path.join(outputDir, "data");
  const uiOutputDir = path.join(outputDir, "ui");
  fs.mkdirSync(dataOutputDir, { recursive: true });
  fs.mkdirSync(uiOutputDir, { recursive: true });

  let count = 0;

  const fileNameCounts = new Map<string, number>();
  const sortedKeys = [...componentsByFile.keys()].sort((a, b) =>
    toPageName(a).localeCompare(toPageName(b)),
  );

  for (const key of sortedKeys) {
    const components = componentsByFile.get(key);
    if (!components) continue;
    const pageName = toPageName(key);
    const countForName = fileNameCounts.get(pageName) ?? 0;
    fileNameCounts.set(pageName, countForName + 1);
    const outputName =
      countForName === 0 ? pageName : `${pageName}${countForName + 1}`;

    const sortedMembers = [...components].sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    );
    const exampleInfo = sortedMembers[0]
      ? buildExampleInfo(sortedMembers[0])
      : undefined;

    // Determine subdirectory based on first component's source
    const subdir = sortedMembers[0] ? getOutputSubdir(sortedMembers[0]) : "ui";
    const outputPath = path.join(outputDir, subdir, `${outputName}.mdx`);

    try {
      fs.writeFileSync(
        outputPath,
        generateGroupedComponentPage(
          pageName,
          sortedMembers,
          exampleInfo,
          subdir,
        ),
        "utf8",
      );
      outputPageNames.push(`${subdir}/${outputName}`);
      count++;
    } catch (error) {
      console.error(`✗ Failed to write ${outputName}.mdx:`, error);
    }
  }

  const relativeOutputDir = path.relative(repoRoot, outputDir);
  console.log(
    `\nGenerated ${count} component MDX files in ${relativeOutputDir}`,
  );
}

main();
