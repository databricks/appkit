import fs from "node:fs";
import path from "node:path";
import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import type { PluginOptions } from "@signalwire/docusaurus-plugin-llms-txt/public";
import { themes as prismThemes } from "prism-react-renderer";
import webpack from "webpack";

const DEVHUB_BASE = "https://www.databricks.com/devhub/docs/appkit/v0";

/**
 * Post-build plugin that replaces all generated HTML pages with redirect pages
 * pointing to the DevHub documentation site. This allows GitHub Pages to serve
 * redirects for all existing URLs while still generating llms.txt and .md files
 * for npm packaging.
 *
 * Static files (schemas, llms.txt, .md) are left untouched.
 */
function redirectToDevHubPlugin() {
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

  return {
    name: "redirect-to-devhub",
    async postBuild({
      outDir,
      routesPaths,
      baseUrl,
    }: {
      outDir: string;
      routesPaths: string[];
      baseUrl: string;
    }) {
      const baseUrlWithoutTrailingSlash = baseUrl.replace(/\/$/, "");

      for (const routePath of routesPaths) {
        // Strip baseUrl prefix (/appkit/) to get the relative path within outDir
        const relativePath = routePath.startsWith(baseUrlWithoutTrailingSlash)
          ? routePath.slice(baseUrlWithoutTrailingSlash.length)
          : routePath;

        // Map old /appkit/docs/{path} → devhub /devhub/docs/appkit/v0/{path}
        // The /docs/ prefix is stripped because devhub flattens it
        const pathWithoutDocs = relativePath.replace(/^\/docs\/?/, "/");
        const devhubUrl = `${DEVHUB_BASE}${pathWithoutDocs || "/"}`;

        const htmlPath = path.join(outDir, relativePath || "", "index.html");
        if (fs.existsSync(htmlPath)) {
          fs.writeFileSync(htmlPath, generateRedirectHtml(devhubUrl));
        }
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
      var target = "${DEVHUB_BASE}" + path + window.location.search + window.location.hash;
      window.location.replace(target);
    })();
  </script>
</head>
<body>
  <p>Redirecting to <a href="${DEVHUB_BASE}/">AppKit Documentation</a>&hellip;</p>
</body>
</html>`;
      fs.writeFileSync(path.join(outDir, "404.html"), notFoundHtml);
    },
  };
}

function appKitAliasPlugin() {
  return {
    name: "appkit-aliases",
    configureWebpack() {
      return {
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "../packages/appkit-ui/src"),
            shared: path.resolve(__dirname, "../packages/shared/src"),
            "@/lib/utils": path.resolve(
              __dirname,
              "../packages/appkit-ui/src/lib/utils",
            ),
            "@/js": path.resolve(__dirname, "../packages/appkit-ui/src/js"),
            "@databricks/appkit-ui/react": path.resolve(
              __dirname,
              "../packages/appkit-ui/src/react",
            ),
          },
        },
        // Replace import.meta references at build time to prevent SSR errors.
        // The appkit-ui source code uses import.meta for Vite HMR, which causes
        // "Cannot use 'import.meta' outside a module" errors when Docusaurus
        // evaluates the server bundle in Node.js CommonJS context during SSG.
        plugins: [
          new webpack.DefinePlugin({
            "import.meta.env.DEV": JSON.stringify(false),
            "import.meta.hot": JSON.stringify(undefined),
          }),
        ],
      };
    },
  };
}

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: "AppKit",
  tagline: "Node.js + React SDK for Databricks Apps. Built for humans and AI.",
  favicon: "img/favicon.ico",

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: "https://databricks.github.io",
  baseUrl: "/appkit/",

  organizationName: "databricks",
  projectName: "appkit",

  onBrokenLinks: "throw",

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/databricks/appkit/edit/main/docs/",
          versions: {
            current: {
              label: `Unreleased 🚧`,
            },
          },
          async sidebarItemsGenerator({
            defaultSidebarItemsGenerator,
            ...args
          }) {
            const sidebarItems = await defaultSidebarItemsGenerator(args);

            return sidebarItems.filter((item) => {
              // Exclude API reference category - handled manually in sidebars.ts
              if (
                item.type === "category" &&
                item.link?.type === "doc" &&
                item.link.id === "api/index"
              ) {
                return false;
              }

              // Exclude api/appkit-ui/index - automatically used as category link in sidebars.ts
              // Explicit dirName in sidebars.ts bypasses automatic exclusion
              if (item.type === "doc" && item.id === "api/appkit-ui/index") {
                return false;
              }

              return true;
            });
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    require.resolve("docusaurus-lunr-search"),
    [
      "docusaurus-plugin-typedoc",
      {
        id: "appkit",
        entryPoints: ["../packages/appkit/src/index.ts"],
        tsconfig: "../packages/appkit/tsconfig.json",
        out: "docs/api/appkit",
        gitRevision: "main",
        useCodeBlocks: true,
        excludeExternals: true,
        excludePrivate: true,
        excludeProtected: false,
        excludeInternal: true,
        indexFormat: "table",
        readme: "none",
        parametersFormat: "table",
        categorizeByGroup: true,
        excludeNotDocumented: false,
        flattenOutputFiles: true,
        expandObjects: true,
        expandParameters: true,
        disableSources: true,
        sidebar: {
          autoConfiguration: true,
          pretty: true,
          typescript: true,
        },
      },
    ],
    appKitAliasPlugin,
    [
      "@signalwire/docusaurus-plugin-llms-txt",
      // docs: https://github.com/signalwire/docusaurus-plugins/blob/main/packages/docusaurus-plugin-llms-txt/README.md
      {
        id: "appkit",
        markdown: {
          enableFiles: true,
          relativePaths: true,
          includeDocs: true,
          includeVersionedDocs: false,
          includeBlog: false,
          includePages: false,
          includeGeneratedIndex: true,
        },
        llmsTxt: {
          siteTitle: "AppKit",
          siteDescription:
            "Node.js + React SDK for Databricks Apps. Built for humans and AI.",
          enableLlmsFullTxt: true,
          autoSectionDepth: 3,
          autoSectionPosition: 2,
          sections: [
            {
              id: "docs",
              name: "General docs",
              position: 1,
              routes: [{ route: "/appkit/docs/*" }],
            },
            {
              id: "appkit-api",
              name: "appkit API reference [collapsed]",
              position: 100,
              routes: [{ route: "/appkit/docs/api/appkit/**" }],
            },
            {
              id: "appkit-ui-api",
              name: "appkit-ui API reference [collapsed]",
              position: 101,
              routes: [{ route: "/appkit/docs/api/appkit-ui/**" }],
            },
          ],
        },
        ui: {
          copyPageContent: {
            display: {
              docs: true,
            },
          },
        },
      } satisfies PluginOptions,
    ],
    redirectToDevHubPlugin,
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    metadata: [
      {
        name: "keywords",
        content:
          "Databricks Apps, Node.js, React.js, SDK, TypeScript, SQL, Databricks, AI, full-stack, development",
      },
    ],
    navbar: {
      title: "AppKit",
      logo: {
        alt: "AppKit",
        src: "img/logo.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Documentation",
        },
        {
          to: "/contributing",
          position: "left",
          label: "Contributing",
        },
        // TODO: Uncomment once we have a first 0.1 release
        // {
        //   type: "docsVersionDropdown",
        //   position: "right",
        // },
        {
          href: "https://github.com/databricks/appkit",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Getting started",
              to: "/docs/",
            },
            {
              label: "API reference",
              to: "/docs/api/",
            },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "Contributing",
              to: "/contributing",
            },
            {
              label: "GitHub",
              href: "https://github.com/databricks/appkit",
            },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "Databricks Apps docs",
              href: "https://docs.databricks.com/aws/en/dev-tools/databricks-apps/",
            },
            {
              label: "Databricks CLI",
              href: "https://github.com/databricks/cli",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Databricks, Inc.`,
    },
    prism: {
      theme: prismThemes.vsLight,
      darkTheme: prismThemes.vsDark,
    },
    mermaid: {
      theme: { light: "base", dark: "dark" },
      options: {
        themeVariables: {
          // Light mode colors (bluish) - matches Docusaurus theme
          primaryColor: "#e3f2fd", // Light blue background
          primaryTextColor: "#1b3139", // Dark text from custom.css
          primaryBorderColor: "#2272b4", // Primary blue border
          lineColor: "#2272b4", // Connection lines
          secondaryColor: "#bbdefb", // Secondary elements
          tertiaryColor: "#f5f5f5", // Tertiary elements
        },
      },
    },
  } satisfies Preset.ThemeConfig,
  markdown: {
    mermaid: true,
  },
  themes: ["@docusaurus/theme-mermaid"],
};

export default config;
