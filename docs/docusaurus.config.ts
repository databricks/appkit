import { themes as prismThemes } from "prism-react-renderer";
import path from "node:path";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import webpack from "webpack";

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
            // exclude API reference - this category is handled manually in sidebars.ts
            return sidebarItems.filter(
              (item) =>
                item.type !== "category" ||
                item.link?.type !== "doc" ||
                item.link.id !== "api/index",
            );
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
        sidebar: {
          autoConfiguration: true,
          pretty: true,
          typescript: true,
        },
      },
    ],
    appKitAliasPlugin,
  ],

  themeConfig: {
    announcementBar: {
      id: "preview-not-for-production",
      content:
        "⚠️ AppKit is in an early development phase and is subject to change without notice. <strong>DO NOT</strong> use in production environments.",
      backgroundColor: "#f0f0f0",
      textColor: "#000000",
      isCloseable: true,
    },
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
      theme: { light: "base", dark: "base" },
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
