import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: "App Kit",
  tagline: "Node.js + React SDK for Databricks Apps. Built for humans and AI.",
  favicon: "img/favicon.ico",

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: "https://databricks.github.io",
  baseUrl: "/app-kit/",

  organizationName: "databricks",
  projectName: "app-kit",

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
          editUrl: "https://github.com/databricks/app-kit/edit/main/docs/",
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
        id: "app-kit",
        entryPoints: ["../packages/app-kit/src/index.ts"],
        tsconfig: "../packages/app-kit/tsconfig.json",
        out: "docs/api/app-kit",
        gitRevision: "main",
        useCodeBlocks: true,
        excludeExternals: true,
        excludePrivate: true,
        excludeProtected: false,
        excludeInternal: true,
        indexFormat: "table",
        readme: "none",
        parametersFormat: "table",
        sidebar: {
          autoConfiguration: true,
          pretty: true,
          typescript: true,
        },
      },
    ],
    [
      "docusaurus-plugin-typedoc",
      {
        id: "app-kit-ui",
        entryPoints: ["../packages/app-kit-ui/src/react/index.ts"],
        tsconfig: "../packages/app-kit-ui/tsconfig.json",
        out: "docs/api/app-kit-ui",
        gitRevision: "main",
        useCodeBlocks: true,
        excludeExternals: true,
        excludePrivate: true,
        excludeProtected: false,
        excludeInternal: true,
        indexFormat: "table",
        readme: "none",
        parametersFormat: "table",
        sidebar: {
          autoConfiguration: true,
          pretty: true,
          typescript: true,
        },
      },
    ],
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
      title: "App Kit",
      logo: {
        alt: "App Kit",
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
          href: "https://github.com/databricks/app-kit",
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
              label: "API Reference",
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
              href: "https://github.com/databricks/app-kit",
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
  } satisfies Preset.ThemeConfig,
};

export default config;
