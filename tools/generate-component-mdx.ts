import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as docgen from "react-docgen-typescript";

type ComponentDoc = docgen.ComponentDoc;

const GITHUB_REPO_URL = "https://github.com/databricks/appkit/blob/main";

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
  return text
    .replace(/\{@link\s+([^}]+)\}/g, "$1")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/\s+/g, " ")
    .trim();
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
  return `
${headingPrefix} Usage

\`\`\`tsx
import { ${displayName} } from '@databricks/appkit-ui';

<${displayName} /* props */ />
\`\`\`
`;
}

function buildComponentDetails(
  component: ComponentDoc,
  opts?: { propsHeadingLevel?: number; usageHeadingLevel?: number },
): string {
  const description = component.description
    ? sanitizeDescriptionText(component.description)
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

function generateGroupedComponentPage(
  groupName: string,
  components: ComponentDoc[],
): string {
  const sections = components
    .map((component) => {
      return `## ${component.displayName}

${buildComponentDetails(component, {
  propsHeadingLevel: 3,
  usageHeadingLevel: 3,
})}`;
    })
    .join("\n\n");

  return `---
title: ${groupName}
---

# ${groupName}

${sections}
`;
}

function findTsxFiles(dir: string) {
  const files: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsxFiles(fullPath);
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      files.push(fullPath);
    }
  }

  return files;
}

function main() {
  const componentsDir = path.join(repoRoot, "packages/appkit-ui/src/react/ui");
  const outputDir = path.join(repoRoot, "docs/docs/api/appkit-ui/components");
  const files = findTsxFiles(componentsDir);
  const componentDocs = parser.parse(files);

  // Filter out non-components (e.g., lifecycle methods incorrectly detected)
  const excludeList = [
    "componentDidMount",
    "componentDidUpdate",
    "componentWillUnmount",
  ];

  const validComponents = componentDocs.filter((component) => {
    const displayName = component.displayName || "";
    return Boolean(displayName) && !excludeList.includes(displayName);
  });

  const sortedComponents = [...validComponents].sort((a, b) =>
    (a.displayName ?? "").localeCompare(b.displayName ?? ""),
  );
  const componentsByFile = new Map<string, ComponentDoc[]>();

  sortedComponents.forEach((component) => {
    const filePath = component.filePath || "";
    const relativePath = filePath ? path.relative(componentsDir, filePath) : "";
    const key = relativePath || component.displayName || "";

    if (!componentsByFile.has(key)) {
      componentsByFile.set(key, []);
    }

    componentsByFile.get(key)?.push(component);
  });

  function toPageName(key: string): string {
    const relativePath = key;
    if (relativePath) {
      const baseName = path.basename(relativePath, path.extname(relativePath));
      const pascal = baseName
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((segment) => segment[0].toUpperCase() + segment.slice(1))
        .join("");
      if (pascal) {
        return pascal;
      }
    }

    const components = componentsByFile.get(key);
    return components?.[0].displayName || "Component";
  }

  const outputPageNames: string[] = [];

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }

  fs.mkdirSync(outputDir, { recursive: true });
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
    const outputPath = path.join(outputDir, `${outputName}.mdx`);
    try {
      fs.writeFileSync(
        outputPath,
        generateGroupedComponentPage(pageName, sortedMembers),
        "utf8",
      );
      outputPageNames.push(outputName);
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
